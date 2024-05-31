const nodemailer = require('nodemailer');


async function sendErrorNotification(errorMessage) {
    try {
        const transporter = nodemailer.createTransport({
            host: 'mail.privateemail.com',
            port: 465,
            auth: {
                user: 'notify@lowpriceparadise.com', // This is the string literal 'apikey', not your SendGrid username
                pass: 'notify123' // Your SendGrid API key
            }
        });

        const mailOptions = {
            from: 'notify@lowpriceparadise.com',
            to: 'john@lowpriceparadise.com, nick@ziptides.com', // Replace with the recipient's email
            subject: 'Webhook Error Notification',
            text: `An error occurred: ${errorMessage}`
        };

        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

module.exports = { sendErrorNotification };
