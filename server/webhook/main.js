const fs = require('fs');
const https = require('https');
const express = require('express');
const cors = require('cors');
const Joi = require('joi');
const { storeVariables, monitorStoredVariables } = require('./monitor.js');
const { sendErrorNotification } = require('./mailer');
const app = express();

// Load the SSL certificate and key
const privateKey = fs.readFileSync('/etc/letsencrypt/live/services.ziptides.com/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/services.ziptides.com/cert.pem', 'utf8');

const credentials = { key: privateKey, cert: certificate };
app.use(cors());
app.use(express.json());

const webhookSchema = Joi.object({
    event: Joi.string().required(),
    test: Joi.object({
        url: Joi.string().uri().required()
    }).optional(),
    check: Joi.object({
        check_id: Joi.string().required(),
        link_id: Joi.string().allow(null),
        number: Joi.string().optional(),
        amount: Joi.number().required(),
        fee: Joi.number().optional(),
        description: Joi.string().optional(),
        status: Joi.string().required(),
        identifier: Joi.string().required(),
        rt_token: Joi.string().allow(null),
        sndr_name: Joi.string().optional(),
        sndr_email: Joi.string().email().required(),
        sndr_bname: Joi.string().allow(null).optional(),
        sndr_lbacc: Joi.string().optional(),
        is_same_day: Joi.number().valid(0, 1).optional(),
        same_day_delay: Joi.number().optional(),
        estimated_at: Joi.string().isoDate().optional(),
        rec_name: Joi.string().optional(),
        rec_email: Joi.string().email().optional(),
        rec_bname: Joi.string().optional(),
        rec_lbacc: Joi.string().optional(),
        is_rtp: Joi.number().valid(0, 1).optional(),
        direction: Joi.string().valid('incoming', 'outgoing').optional(),
        debit_date: Joi.string().optional(),
        credit_date: Joi.string().allow(null).optional(),
        printed_date: Joi.string().allow(null).optional(),
        recurring: Joi.boolean().optional(),
        receive_date: Joi.string().optional(),
        error_code: Joi.string().allow('').optional(),
        error_description: Joi.string().allow('').optional(),
        error_explanation: Joi.string().allow('').optional()
    }).optional(),
    timestamp: Joi.string().isoDate().required(),
    next_billing_date: Joi.string().allow(null).optional() // Add this line
}).or('test', 'check');


app.post('/webhook', async (req, res) => {
    const { error, value } = webhookSchema.validate(req.body);
    if (error) {
        console.error('Invalid data format:', error.details);
        sendErrorNotification(`Response not processed as a valid payment\nStatus: ${data.check.status}\n\n${JSON.stringify(req.body, null, 2)}\n`);
        return res.status(400).send('Invalid data format');
    }

    const data = value;
    fs.appendFileSync('webhook-data.txt', `${JSON.stringify(data, null, 2)}\n`);

    if (data.check && ['pending', 'processed'].includes(data.check.status)) {
        try {
            const identifier = data.check.identifier;
            const status_id = 11; // Adjust this line based on actual data structure
            const payment_method = "Bank ACH via Paynote"; // Adjust this line based on actual data structure

            storeVariables(payment_method, status_id, identifier);
            res.sendStatus(200);
        } catch (error) {
            console.error('Error processing webhook:', error);
            sendErrorNotification(`'Error processing webhook: ${error.message}`);
            res.sendStatus(500);
        }
    } else {
        // Ignore "unpaid" status or other statuses
        res.sendStatus(200);
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
