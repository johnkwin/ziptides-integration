// monitor.js (or the file where your monitoring function is)
const fs = require('fs');
const axios = require('axios');
const config = require('./config'); // Import the config file

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

const storeVariables = (paymentMethod, statusId, cartId) => {
    const newData = {
        PAYMENT_METHOD: paymentMethod,
        STATUS_ID: statusId,
        ORDER_ID: cartId,
        DATE_ADDED: Date.now()
    };

    let currentData = [];
    if (fs.existsSync(config.FILE_PATH)) {
        const fileData = fs.readFileSync(config.FILE_PATH, 'utf8');
        currentData = JSON.parse(fileData) || [];
    }

    const currentTime = Date.now();
    currentData = currentData.filter(data => currentTime - data.DATE_ADDED <= 86400000 && data.ORDER_ID !== cartId);

    currentData.push(newData);
    fs.writeFileSync(config.FILE_PATH, JSON.stringify(currentData, null, 2));
};

const monitorStoredVariables = async () => {
    const interval = config.INTERVAL;
    const timeout = config.TIMEOUT;

    setInterval(async () => {
        if (!fs.existsSync(config.FILE_PATH)) {
            return;
        }

        const currentTime = Date.now();
        let currentData = JSON.parse(fs.readFileSync(config.FILE_PATH, 'utf8')) || [];

        for (let i = 0; i < currentData.length; i++) {
            const data = currentData[i];

            if (currentTime - data.DATE_ADDED > timeout) {
                console.log(`Removing stale entry for order ID ${data.ORDER_ID}`);
                currentData.splice(i, 1);
                i--;
                continue;
            }

            const order_id = await getOrderIDbyCartID(data.ORDER_ID);
            if (!order_id) {
                console.log(`Order ID ${data.ORDER_ID} not found yet`);
                continue;
            }

            const orderDetails = await getOrderDetails(order_id);
            if (!orderDetails) {
                console.log(`Unable to retrieve details for order ID ${order_id}`);
                continue;
            }

            if (orderDetails.status_id !== 11 || orderDetails.payment_method !== 'Bank ACH via Paynote') {
                console.log(`Updating order ID ${order_id}`);
                await updateOrder(order_id, 11, 'Bank ACH via Paynote');
            } else {
                console.log(`Order ID ${order_id} is correctly set. Removing from check.`);
                currentData.splice(i, 1);
                i--;
            }
        }

        fs.writeFileSync(config.FILE_PATH, JSON.stringify(currentData, null, 2));
    }, interval);
};

module.exports = { storeVariables, monitorStoredVariables };
