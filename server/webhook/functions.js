// main.js (or your main application file)
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios');
const { storeVariables, monitorStoredVariables } = require('functions');
const config = require('../../config'); // Import the config file

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const getOrderIDbyCartID = async (cart_id) => {
    try {
        const response = await axios.get(`https://api.bigcommerce.com/stores/${config.STORE_HASH}/v2/orders?cart_id=${encodeURIComponent(cart_id)}`, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Auth-Token': config.API_TOKEN
            }
        });
        const orders = response.data;
        for (const order of orders) {
            if (order.cart_id === cart_id) {
                return order.id;
            }
        }
        return null;
    } catch (error) {
        console.error('Error fetching order:', error);
        return null;
    }
};

const getOrderDetails = async (order_id) => {
    try {
        const response = await axios.get(`https://api.bigcommerce.com/stores/${config.STORE_HASH}/v2/orders/${order_id}`, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Auth-Token': config.API_TOKEN
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching order details:', error);
        return null;
    }
};

const updateOrder = async (order_id, status_id, payment_method) => {
    try {
        const response = await axios.put(`https://api.bigcommerce.com/stores/${config.STORE_HASH}/v2/orders/${order_id}`, {
            status_id,
            payment_method
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Auth-Token': config.API_TOKEN
            }
        });
        fs.appendFileSync('webhook-data.txt', `orderUpdate: ${JSON.stringify(response.data, null, 2)}\n`);
        return response.data;
    } catch (error) {
        console.error('Error updating order:', error);
        return null;
    }
};

app.post('/webhook', async (req, res) => {
    const data = req.body;
    fs.appendFileSync('webhook-data.txt', `${JSON.stringify(data, null, 2)}\n`);

    if (data && data.check && data.check.identifier) {
        const identifier = data.check.identifier;
        const status = data.check.status;
        let status_id = 7;
        let payment_method = "Bank ACH via Paynote (PENDING)";

        if (status === 'processed') {
            status_id = 11;
            payment_method = "Bank ACH via Paynote";
        }

        storeVariables(payment_method, status_id, identifier);
        res.sendStatus(200);
    } else {
        res.sendStatus(400);
    }
});

app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
    monitorStoredVariables(); // Start monitoring stored variables
});
