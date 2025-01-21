const fs = require('fs');
const https = require('https');
const cors = require('cors');
const express = require('express');
const axios = require('axios');
const { storeVariables, getStoredVariableByOrderId, monitorStoredVariables, updateOrder } = require('./monitor');
const { sendErrorNotification } = require('./mailer');
const app = express();
const config = require('../../config');
const allowedOrigins = [
    'https://unitedlabsupply.com',
    'https://services.unitedlabsupply.com',
    'https://ziptides.com',
    'https://services.ziptides.com',
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));
app.use((req, res, next) => {
    console.log(`Request received for hostname: ${req.hostname}`);
    console.log(`SiteConfig:`, determineSiteConfig(req.hostname));
    next();
});

// Handle preflight requests
app.options('*', cors());
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
    if (hostname.includes('ziptides')) {
        return config.Ziptides; // Ziptides configuration
    } else if (hostname.includes('unitedlabsupply')) {
        return config.UnitedLabSupply; // UnitedLabSupply configuration
    } else {
        throw new Error(`No configuration found for hostname: ${hostname}`);
    }
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
app.use(express.json());

// Example endpoint
app.post('/create-payment', async (req, res) => {
    const siteConfig = determineSiteConfig(req.hostname); // Dynamically determine site config based on hostname

    const { cartId, firstName, lastName, requestFor, countryCode, amount, ipAddress, source } = req.body;
    console.log('Hostname:', req.hostname);
    console.log('Resolved Config:', determineSiteConfig(req.hostname));
    console.log('API Token:', siteConfig.API_TOKEN);
    console.log('Store Hash:', siteConfig.STORE_HASH);

    try {
        // Generate the checkout token
        const tokenResponse = await axios.post(
            `https://api.bigcommerce.com/stores/${siteConfig.STORE_HASH}/v3/checkouts/${cartId}/token`,
            { maxUses: 1, ttl: 86400 },
            {
                headers: {
                    'X-Auth-Token': siteConfig.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        const checkoutToken = tokenResponse.data.data.checkoutToken;

        // Create a new order
        const orderResponse = await axios.post(
            `https://api.bigcommerce.com/stores/${siteConfig.STORE_HASH}/v3/checkouts/${cartId}/orders`,
            {},
            {
                headers: {
                    'X-Auth-Token': siteConfig.API_TOKEN,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            }
        );

        const newOrderId = orderResponse.data.data.id;

        // Use siteConfig.DOMAIN to ensure the correct domain is used for the redirect URL
        const redirectUrl = `https://${siteConfig.DOMAIN}/checkout/order-confirmation/${newOrderId}?t=${checkoutToken}`;

        // Request payment via DFIN
        const fetchModule = await import('node-fetch');
        const fetch = fetchModule.default;
        const Headers = fetchModule.Headers;

        const myHeaders = new Headers();
        myHeaders.append('Authorization', `Bearer ${siteConfig.DFIN_PUBLIC}`);
        myHeaders.append('Content-Type', 'application/json');

        const body = JSON.stringify({
            api_secret: siteConfig.DFIN_SECRET,
            first_name: firstName,
            last_name: lastName,
            request_for: requestFor,
            country_code: countryCode,
            amount: amount,
            redirect_url: redirectUrl,
            redirect_time: '2',
            ip_address: ipAddress,
            meta_data: { request_id: cartId },
            send_notifications: 'yes',
            source: source,
        });

        const requestOptions = {
            method: 'POST',
            headers: myHeaders,
            body: body,
            redirect: 'follow',
        };

        console.log(`Payment request body for ${siteConfig.DOMAIN}:`, body);

        const response = await fetch('https://sell.rtpay.co/api/request-payment', requestOptions);
        const result = await response.json();

        if (result && result.status === 'success' && result.data && result.data.payment_link) {
            // Store variables after generating the payment link
            storeVariables(cartId, 1, requestFor);
            res.json({ payment_link: result.data.payment_link });
        } else {
            console.error('Unexpected response format:', result);
            sendErrorNotification(`Error fetching payment link: ${JSON.stringify(result)}`);
            res.status(500).send('Error fetching payment link');
        }
    } catch (error) {
        console.error(`Error processing payment for ${siteConfig.DOMAIN}:`, error.message);
        sendErrorNotification(`Error processing payment: ${error.message}`);
        res.status(500).send('Error processing payment');
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
    const data = req.body;

    console.log('Received webhook data from DFIN:', JSON.stringify(data, null, 2));

    try {
        // Validate webhook data structure
        if (!data || data.status !== 'succeeded' || !data.description) {
            console.error('Invalid webhook data:', data);
            return res.status(400).send('Invalid webhook data');
        }

        // Extract the order-id from the description
        const description = data.description;
        const orderIdMatch = description.match(/Payment ID\s*:\s*([\w-]+)/);
        if (!orderIdMatch || orderIdMatch.length < 2) {
            console.error('Order ID not found in description:', description);
            return res.status(400).send('Order ID not found in description');
        }

        const orderId = orderIdMatch[1];
        console.log('Extracted Order ID:', orderId);

        // Fetch stored order data
        const storedOrder = getStoredVariableByOrderId(orderId);
        if (!storedOrder) {
            console.error('Order not found in stored data for Order ID:', orderId);
            return res.status(404).send('Order not found in stored data');
        }

        console.log('Matching stored order:', storedOrder);

        // Update the order in BigCommerce
        const updatedOrder = await updateOrder(
            storedOrder.order_id,
            11, // Assuming 11 is the status ID for a successful transaction
            'Card', // Payment method from the webhook payload
            data.payment_method // Payment provider ID from the webhook payload
        );

        if (updatedOrder) {
            console.log('Order successfully updated:', updatedOrder);
            res.status(200).send('Order status updated successfully');
        } else {
            console.error('Failed to update order for Order ID:', orderId);
            res.status(500).send('Failed to update order');
        }
    } catch (error) {
        console.error('Error processing update-order-status:', error);
        res.status(500).send('Error processing update-order-status');
    }
});

// Error notification endpoint
app.post('/notify-error', (req, res) => {
    const { errorMessage } = req.body;
    sendErrorNotification(errorMessage);
    res.sendStatus(200);
});

// Start the server on a single port
httpsServer.listen(3030, () => {
    console.log('HTTPS Server is running on port 3030');
    monitorStoredVariables();
});
