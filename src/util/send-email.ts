import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';

dotenv.config();

const {
    EMAIL,
    CLIENT_ID,
    CLIENT_SECRET,
    REFRESH_TOKEN
} = process.env;

const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

const oAuth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

interface EmailOptions {
    to: string;
    subject: string;
    text: string;
}

export async function sendEmail({ to, subject, text }: EmailOptions): Promise<void> {
    const accessTokenResponse = await oAuth2Client.getAccessToken();
    const accessToken = accessTokenResponse?.token;

    if (!accessToken) {
        throw new Error('Unable to get access token');
    }

    // This typing works with nodemailer@6+
    const transporter = nodemailer.createTransport({
        // Nodemailer knows these fields; TS won't complain here
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            type: 'OAuth2',
            user: EMAIL,
            clientId: CLIENT_ID!,
            clientSecret: CLIENT_SECRET!,
            refreshToken: REFRESH_TOKEN!,
            accessToken
        }
    } as nodemailer.TransportOptions); // <- KEY FIX

    await transporter.sendMail({
        from: `DECWAR <${EMAIL}>`,
        to,
        subject,
        text
    });
}

// Test it
// sendEmail({
//   to: 'erictfree@mac.com',
//   subject: 'Test Email from DECWAR',
//   text: 'This is a working Gmail OAuth2 email from Node + TypeScript'
// });
