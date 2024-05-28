const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const OAuth2 = google.auth.OAuth2;

/*const oauth2Client = new OAuth2(
    '38782066727-gnr3hp167ncn9lhn9727gnneklaso8et.apps.googleusercontent.com', // Replace with your Client ID
    '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', // Replace with your Client Secret
    'https://developers.google.com/oauthplayground' // Redirect URL
);*/

//oauth2Client.setCredentials({
 //   refresh_token: '1//04AkvTK7yUfplCgYIARAAGAQSNwF-L9IroocrH5vm4HVprFs_DloCdJGYpMPywaHYoQ_D2SunM5-BfyCk5WbPPpA27GMDxyNSuxw'
//});

async function getAccessToken() {
    try {
        const response = await oauth2Client.getAccessToken();
        if (response.token) {
            console.log('Access token obtained:', response.token);
            return response.token;
        } else {
            throw new Error('Failed to obtain access token');
        }
    } catch (error) {
        console.error('Error obtaining access token:', error);
        throw error;
    }
}

async function sendErrorNotification(errorMessage) {
    try {
        const accessToken = await getAccessToken();
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                type: 'OAuth2',
                user: 'ziptidesreports@gmail.com',
                clientId: '38782066727-gnr3hp167ncn9lhn9727gnneklaso8et.apps.googleusercontent.com',
                clientSecret: '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',
                refreshToken: '1//04AkvTK7yUfplCgYIARAAGAQSNwF-L9IroocrH5vm4HVprFs_DloCdJGYpMPywaHYoQ_D2SunM5-BfyCk5WbPPpA27GMDxyNSuxw',
                accessToken: accessToken
            }
        });

        const mailOptions = {
            from: 'ziptidesreports@gmail.com',
            to: 'john@lowpriceparadise.com', // Replace with the recipient's email
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
