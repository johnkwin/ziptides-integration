const fs = require('fs');
const axios = require('axios');
const config = require('../../config');

const determineSiteConfig = (hostname) => {
    if (hostname.includes('ziptides')) {
        return config.Ziptides;
    } else if (hostname.includes('unitedlabsupply')) {
        return config.UnitedLabSupply;
    } else {
        throw new Error(`No configuration found for hostname: ${hostname}`);
    }
};

const getOrderIDbyCartID = async (cart_id, hostname) => {
    const siteConfig = determineSiteConfig(hostname);
    try {
        console.log(`Fetching order by cart ID: ${cart_id}`);
        const response = await axios.get(
            `https://api.bigcommerce.com/stores/${siteConfig.STORE_HASH}/v2/orders?cart_id=${encodeURIComponent(cart_id)}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-Auth-Token': siteConfig.API_TOKEN,
                },
            }
        );
        //console.log('Response from getOrderIDbyCartID:', response.data);
        const orders = response.data;
        for (const order of orders) {
            if (order.cart_id === cart_id) {
                console.log(`Order ID found: ${order.id}`);
                return order.id;
            }
        }
        console.log('Order ID not found');
        return null;
    } catch (error) {
        console.error('Error fetching order by cart ID:', error.response?.data || error.message);
        return null;
    }
};

const getOrderDetails = async (order_id, hostname) => {
    const siteConfig = determineSiteConfig(hostname);
    try {
        console.log(`Fetching order details for Order ID: ${order_id}`);
        const response = await axios.get(
            `https://api.bigcommerce.com/stores/${siteConfig.STORE_HASH}/v2/orders/${order_id}`,
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-Auth-Token': siteConfig.API_TOKEN,
                },
            }
        );
        //console.log('Order details response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error fetching order details:', error.response?.data || error.message);
        return null;
    }
};

const updateOrder = async (order_id, status_id, payment_method, payment_provider_id) => {
    // Fetch stored variables to find the hostname
    const storedOrder = getStoredVariableByOrderId(order_id);

    if (!storedOrder) {
        console.error(`Stored data not found for Order ID: ${order_id}`);
        return null;
    }
    
    const hostname = storedOrder.hostname;

    if (!hostname) {
        console.error(`Hostname is missing for Order ID: ${order_id} in stored data`);
        return null;
    }

    // Determine site configuration using the hostname
    const siteConfig = determineSiteConfig(hostname);

    try {
        console.log(`Updating Order ID: ${order_id} for hostname: ${hostname}`);
        const response = await axios.put(
            `https://api.bigcommerce.com/stores/${siteConfig.STORE_HASH}/v2/orders/${order_id}`,
            { status_id, payment_method, payment_provider_id },
            {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-Auth-Token': siteConfig.API_TOKEN,
                },
            }
        );
        console.log('Order update response:', response.data);
        fs.appendFileSync('webhook-data.txt', `orderUpdate: ${JSON.stringify(response.data, null, 2)}\n`);
        return response.data;
    } catch (error) {
        console.error(`Error updating Order ID: ${order_id}`, error.response?.data || error.message);
        return null;
    }
};

const storeVariables = (order_id, status_id, transaction_id, hostname) => {
    const newData = {
        order_id,
        status_id,
        transaction_id,
        date_added: Date.now(),
        hostname,
    };

    let currentData = [];
    if (fs.existsSync(config.FILE_PATH)) {
        const fileData = fs.readFileSync(config.FILE_PATH, 'utf8');
        currentData = JSON.parse(fileData) || [];
    }

    const currentTime = Date.now();
    currentData = currentData.filter(
        (data) => currentTime - data.date_added <= 86400000 && data.order_id !== order_id
    );

    currentData.push(newData);
    fs.writeFileSync(config.FILE_PATH, JSON.stringify(currentData, null, 2));
};

const getStoredVariableByOrderId = (order_id) => {
    try {
        if (!fs.existsSync(config.FILE_PATH)) {
            console.error(`File not found: ${config.FILE_PATH}`);
            return null;
        }

        const fileData = fs.readFileSync(config.FILE_PATH, 'utf8');
        const currentData = JSON.parse(fileData) || [];

        // Debug log current data
        console.log('Current stored data:', JSON.stringify(currentData, null, 2));

        // Debug log order_id being searched
        console.log('Searching for Order ID:', order_id);

        const result = currentData.find((data) => data.order_id.trim() === order_id.trim());

        if (!result) {
            console.error(`Order ID ${order_id} not found in stored data.`);
        }

        return result || null;
    } catch (error) {
        console.error(`Error in getStoredVariableByOrderId: ${error.message}`);
        return null;
    }
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

            if (currentTime - data.date_added > timeout) {
                console.log(`Removing stale entry for order ID ${data.order_id}`);
                currentData.splice(i, 1);
                i--;
                continue;
            }

            const order_id = await getOrderIDbyCartID(data.order_id, data.hostname);
            if (!order_id) {
                console.log(`Order ID ${data.order_id} not found yet`);
                continue;
            }

            const orderDetails = await getOrderDetails(order_id, data.hostname);
            if (!orderDetails) {
                console.log(`Unable to retrieve details for order ID ${order_id}`);
                continue;
            }

            if (
                orderDetails.status_id !== 11 ||
                orderDetails.payment_method !== 'Manual' ||
                orderDetails.payment_provider_id !== data.transaction_id
            ) {
                if (data.status_id === 11) {
                    console.log(`Updating order ID ${order_id}`);
                    await updateOrder(order_id, 11, 'Manual', data.transaction_id, data.hostname);
                } else {
                    console.log(`Skipping order ID ${order_id} -- Still not paid.`);
                }
            } else {
                console.log(`Order ID ${order_id} is correctly set. Removing from check.`);
                currentData.splice(i, 1);
                i--;
            }
        }

        fs.writeFileSync(config.FILE_PATH, JSON.stringify(currentData, null, 2));
    }, interval);
};

module.exports = {
    storeVariables,
    getStoredVariableByOrderId,
    monitorStoredVariables,
    getOrderIDbyCartID,
    getOrderDetails,
    updateOrder,
};
