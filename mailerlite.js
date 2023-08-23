const fetch = require('node-fetch');
const conf = require('ocore/conf.js');

const mailerliteController = async (ctx) => {
    const email = String(ctx.request.body.email || '');

    try {
        if (!email || !email.includes('@')) {
            ctx.status = 400;
            ctx.body = 'Invalid email';
            return;
        } else {
            const res = await fetch.default(`https://api.mailerlite.com/api/v2/subscribers`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-MailerLite-ApiKey': conf.mailerlite_api_key,
                },
                body: JSON.stringify({
                    email: String(email)
                }),
            });

            const resData = await res.json();

            if (resData.error) {
                ctx.status = resData.error.code;
                ctx.body = resData.error_details;
            }

            ctx.status = 200;
        }

    } catch (e) {
        ctx.body = "Unknown error";
        ctx.status = 400;
    }
}

exports.mailerliteController = mailerliteController;