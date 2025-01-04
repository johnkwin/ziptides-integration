const fs = require('fs');
const https = require('https');
const cors = require('cors');
const express = require('express');
const axios = require('axios');
const { storeVariables, getStoredVariableByOrderId, monitorStoredVariables } = require('./monitor');
const { sendErrorNotification } = require('./mailer');
const app = express();
const config = require('../../config');

// Define a map for certificates
const certificateMap = {
    'services.ziptides.com': {
        key: fs.readFileSync('/etc/letsencrypt/live/services.ziptides.com/privkey.pem', 'utf8'),
        cert: fs.readFileSync('/etc/letsencrypt/live/services.ziptides.com/fullchain.pem', 'utf8'),
    },
    'services.unitedlabsupply.com': {
        key: fs.readFileSync('/etc/letsencrypt/live/services.unitedlabsupply.com/privkey.pem', 'utf8'),
        cert: fs.readFileSync('/etc/letsencrypt/live/services.unitedlabsupply.com/fullchain.pem', 'utf8'),
    },
};

// Function to determine site configuration based on the request's hostname
const determineSiteConfig = (hostname) => {
    const siteConfig = siteConfigMap[hostname];
    if (!siteConfig) {
        throw new Error(`No configuration found for hostname: ${hostname}`);
    }
    return siteConfig;
};

// Create an HTTPS server with SNI (Server Name Indication) support
const httpsServer = https.createServer(
    {
        SNICallback: (domain, callback) => {
            const cert = certificateMap[domain];
            if (cert) {
                callback(null, cert);
            } else {
                callback(new Error('No certificate found for domain: ' + domain));
            }
        },
    },
    app
);

app.use(cors());
app.use(express.json());

// Example endpoint
app.post('/create-payment', async (req, res) => {

    const siteConfig = determineSiteConfig(req.hostname);

    const { cartId, firstName, lastName, requestFor, countryCode, amount, ipAddress, source } = req.body;

    try {
        const tokenResponse = await axios.post(
            `https://api.bigcommerce.com/stores/${config.STORE_HASH}/v3/checkouts/${cartId}`,
            { maxUses: 1, ttl: 86400 },
            {
                headers: {
                    'X-Auth-Token': config.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        const checkoutToken = tokenResponse.data.data.checkoutToken;
        const newOrderId = await axios.post(
            `https://api.bigcommerce.com/stores/${config.STORE_HASH}/v3/checkouts/${cartId}/orders`,
            {},
            {
                headers: {
                    'X-Auth-Token': config.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        const redirectUrl = `https://${req.hostname}/checkout/order-confirmation/${newOrderId}?t=${checkoutToken}`;
        res.json({ redirectUrl });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).send('An error occurred');
    }
});

app.post('/webhook', async (req, res) => {
    const data = req.body;

    // Log the received data for debugging purposes
    console.log('Received webhook data:', JSON.stringify(data, null, 2));
    fs.appendFileSync('webhook-data.txt', `${JSON.stringify(data, null, 2)}\n`);

    try {
        // Check if the payment succeeded
        if (data.status === 'succeeded' && data.data && data.data.metadata) {
            let metadata = data.data.metadata;

            // Log the raw metadata for debugging
            console.log('Raw metadata:', metadata);

            // If metadata is a JSON string, parse it
            if (typeof metadata === 'string') {
                try {
                    metadata = JSON.parse(metadata);
                } catch (error) {
                    console.error('Error parsing metadata JSON:', error);
                    sendErrorNotification('Error parsing metadata JSON: ' + error.message);
                    return res.status(400).send('Invalid metadata format');
                }
            }

            // Check if metadata is an array of JSON strings
            if (Array.isArray(metadata)) {
                try {
                    // Parse each metadata item
                    metadata = metadata.map(item => {
                        try {
                            return JSON.parse(item);
                        } catch (error) {
                            console.error('Error parsing metadata item:', error);
                            sendErrorNotification('Error parsing metadata item: ' + error.message);
                            return null;
                        }
                    }).filter(item => item !== null);

                    console.log('Parsed metadata:', metadata);

                    // Ensure metadata is an array and find the request_id
                    const requestIdEntry = metadata.find(item => item.request_id);
                    const requestId = requestIdEntry ? requestIdEntry.request_id : null;

                    if (requestId) {
                        console.log('Payment succeeded, request_id (cart_id):', requestId);

                        // Store variables
                        const identifier = requestId;
                        const status = 11;
                        const transaction_id = data.transaction_id;

                        // Update storedVariables with the new order status and transaction_id
                        storeVariables(identifier, status, transaction_id);
                        res.sendStatus(200);
                    } else {
                        console.error('request_id not found in metadata.');
                        sendErrorNotification('request_id not found in metadata.');
                        res.status(400).send('request_id not found in metadata.');
                    }
                } catch (error) {
                    console.error('Error processing metadata array:', error);
                    sendErrorNotification('Error processing metadata array: ' + error.message);
                    res.status(400).send('Invalid metadata format');
                }
            } else {
                console.error('Metadata is not an array.');
                sendErrorNotification('Metadata is not an array.');
                res.status(400).send('Invalid metadata format');
            }
        } else {
            console.error('Payment not successful or missing metadata.');
            sendErrorNotification('Payment not successful or missing metadata.');
            res.status(400).send('Payment not successful or missing metadata.');
        }
    } catch (error) {
        console.error('Error processing webhook:', error);
        sendErrorNotification('Error processing webhook: ' + error.message);
        res.status(500).send('Error processing webhook.');
    }
});

// Update order status endpoint
app.post('/update-order-status', async (req, res) => {
    const { order_id } = req.body;

    const storedData = getStoredVariableByOrderId(order_id);

    if (!storedData || storedData.status_id !== 11) {
        return res.status(400).send('Invalid or non-waiting order_id');
    }

    try {
        const newOrderId = await getOrderIDbyCartID(order_id);
        if (!newOrderId) {
            return res.status(400).send('Order ID not found');
        }

        await axios.put(
            `https://api.bigcommerce.com/stores/${config.STORE_HASH}/v2/orders/${newOrderId}`,
            {
                payment_method: 'Manual',
                payment_provider_id: storedData.transaction_id,
                status_id: 11
            },
            {
                headers: {
                    'X-Auth-Token': config.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        // Update the status to 11 (completed)
        //storeVariables(order_id, 11, storedData.transaction_id);
        res.sendStatus(200);
    } catch (error) {
        console.error('Error updating order status:', error);
        sendErrorNotification('Error updating order status: ' + error.message);
        res.status(500).send('Error updating order status');
    }
});

// Error notification endpoint
app.post('/notify-error', (req, res) => {
    const { errorMessage } = req.body;
    sendErrorNotification(errorMessage);
    res.sendStatus(200);
});

// Start the server on a single port
httpsServer.listen(3000, () => {
    console.log('HTTPS Server is running on port 3000');
    monitorStoredVariables();
});
