const fs = require('fs');
const https = require('https');
const cors = require('cors');
const Joi = require('joi');
const express = require('express');
const axios = require('axios');
const { storeVariables, getStoredVariableByOrderId, monitorStoredVariables } = require('./monitor');
const { sendErrorNotification } = require('./mailer');
const app = express();
const config = require('../../config');

// Load the SSL certificate and key
const privateKey = fs.readFileSync('/etc/letsencrypt/live/services.ziptides.com/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/services.ziptides.com/cert.pem', 'utf8');

const credentials = { key: privateKey, cert: certificate };
app.use(cors());
app.use(express.json());

app.post('/create-payment', async (req, res) => {
    const { cartId, firstName, lastName, requestFor, countryCode, amount, ipAddress, source } = req.body;

    try {
        const fetchModule = await import('node-fetch');
        const fetch = fetchModule.default;
        const Headers = fetchModule.Headers;

        // Process the order
        const tokenResponse = await axios.post(
            `https://api.bigcommerce.com/stores/${config.STORE_HASH}/v3/checkouts/${cartId}/token`,
            { maxUses: 1, ttl: 86400 },
            {
                headers: {
                    'X-Auth-Token': config.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        const checkoutToken = tokenResponse.data.data.checkoutToken;
        const checkoutId = cartId;

        const orderResponse = await axios.post(
            `https://api.bigcommerce.com/stores/${config.STORE_HASH}/v3/checkouts/${checkoutId}/orders`,
            {},
            {
                headers: {
                    'X-Auth-Token': config.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            }
        );

        const newOrderId = orderResponse.data.data.id;

        const redirectUrl = `https://ziptides.com/checkout/order-confirmation/${newOrderId}?t=${checkoutToken}`;

        const myHeaders = new Headers();
        myHeaders.append("Authorization", `Bearer ${config.DFIN_PUBLIC}`);
        myHeaders.append("Content-Type", "application/json");

        const body = JSON.stringify({
            api_secret: config.DFIN_SECRET,
            first_name: firstName,
            last_name: lastName,
            request_for: requestFor,
            country_code: countryCode,
            amount: amount,
            redirect_url: redirectUrl,
            redirect_time: "2",
            ip_address: ipAddress,
            meta_data: JSON.stringify({ request_id: cartId }),
            send_notifications: "yes",
            source: source
        });

        const requestOptions = {
            method: "POST",
            headers: myHeaders,
            body: body,
            redirect: "follow"
        };

        console.log(body);
        const response = await fetch("https://sell.dfin.ai/api/request-payment", requestOptions);
        const result = await response.json();

        if (result && result.status === 'success' && result.data && result.data.payment_link) {
            // Store variables after generating the payment link
            storeVariables(cartId, 1, requestFor);
            res.json({ payment_link: result.data.payment_link });
        } else {
            console.error('Unexpected response format:', result);
            sendErrorNotification('Error fetching payment link: ' + JSON.stringify(result));
            res.status(500).send('Error fetching payment link');
        }
    } catch (error) {
        console.error('Error processing payment:', error);
        sendErrorNotification('Error processing payment: ' + error.message);
        res.status(500).send('Error processing payment');
    }
});

// Webhook endpoint
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

// Create the HTTPS server
const httpsServer = https.createServer(credentials, app);

// Start the server on port 3000
httpsServer.listen(3000, () => {
    console.log('HTTPS Server is running on port 3000');
    monitorStoredVariables(); // Start monitoring stored variables
});
