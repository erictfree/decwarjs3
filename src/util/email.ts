import mailchimp from "@mailchimp/mailchimp_marketing";

export async function addEmailToMailchimp(email: string) {

    try {
        await sendEmailToMailchimp(email);
    } catch (err) {
        console.error("Mailchimp error:", err);
    }
}

// --- Main Function ---
export async function sendEmailToMailchimp(email: string): Promise<AddEmailResult | null> {
    if (!mailchimpApiKey) {
        console.error("Cannot add email: MAILCHIMP_API_KEY is missing.");
        return null;
    }

    try {
        const response = await mailchimp.lists.addListMember(listId, {
            email_address: email,
            status: "subscribed",
        });

        if (
            typeof response === "object" &&
            response &&
            "id" in response &&
            "email_address" in response &&
            "status" in response
        ) {
            return {
                id: response.id,
                email_address: response.email_address,
                status: String(response.status),
            };
        }

        console.warn("Unexpected Mailchimp response format:", response);
        return null;
    } catch (error: unknown) {
        const status = (error as { response?: { status?: unknown } })?.response?.status;
        const detail = (error as { response?: { body?: { detail?: string } }; message?: string })?.response?.body?.detail ||
            (error as { message?: string })?.message;

        console.error("Mailchimp API error:", {
            status,
            detail,
        });

        return null;
    }
}
interface AddEmailResult {
    id: string;
    email_address: string;
    status: string;
}

// Debug environment variable loading
// console.log("Environment check:", {
//   NODE_ENV: process.env.NODE_ENV,
//   MAILCHIMP_API_KEY_exists: 'MAILCHIMP_API_KEY' in process.env,
//   MAILCHIMP_API_KEY_length: process.env.MAILCHIMP_API_KEY?.length,
//   MAILCHIMP_API_KEY_first_chars: process.env.MAILCHIMP_API_KEY?.substring(0, 4) + '...'
// });

interface AddEmailResult {
    id: string;
    email_address: string;
    status: string;
}

// --- Configuration ---
const mailchimpApiKey = "13b7619d7fb05d56776b3a9db47bc26c-us20";//process.env.MAILCHIMP_API_KEY;
const mailchimpServer = "us20"; // Extract this from your API key suffix
const listId = "cc1961a126";

if (!mailchimpApiKey) {
    console.warn("MAILCHIMP_API_KEY environment variable is not set.");
} else {
    mailchimp.setConfig({
        apiKey: mailchimpApiKey,
        server: mailchimpServer,
    });

    // console.log("Mailchimp configured:", {
    //   server: mailchimpServer,
    //   apiKeyPresent: true,
    //   apiKeyLength: .length,
    // });
}

