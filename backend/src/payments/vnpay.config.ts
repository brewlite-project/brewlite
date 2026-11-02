import 'dotenv/config';

export type VnpayConfig = {
    tmnCode: string;
    hashSecret: string;
    paymentUrl: string;
    returnUrl: string;
};

function requireEnv(name: string): string {
    const value = process.env[name];

    if (!value || !value.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value.trim();
}

function requireSecret(name: string): string {
    const value = process.env[name];

    if(!value || !value.trim()) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    if(value !== value.trim()) {
        throw new Error(`Invalid whitespace in environment variable: ${name}`);
    }

    return value;
}

function requireHttpsUrl(value: string, name: string): URL {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid URL for environment variable: ${name}`);
    }

    if (url.protocol !== 'https:') {
        throw new Error(`${name} must be HTTPS`);
    }

    return url;
}

function requireReturnUrl(value: string): string {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new Error ('Invalid VNPAY_RETURN_URL');
    }

    const isLocal =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1';

    const isDevelopment = process.env.NODE_ENV !== 'production';

    const allowedProtocol =
        url.protocol === 'https:' ||
        (isDevelopment && isLocal && url.protocol === 'http:');

    if (
        !allowedProtocol ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
    ) {
        throw new Error('Invalid VNPAY_RETURN_URL configuration.');
    }
    return url.toString();
}

export function loadVnpayConfig(): VnpayConfig {
    const tmnCode = requireEnv('VNPAY_TMN_CODE');
    const hashSecret = requireSecret('VNPAY_HASH_SECRET');
    const paymentUrl = requireHttpsUrl(
        requireEnv('VNPAY_PAYMENT_URL'),
        'VNPAY_PAYMENT_URL'
    ).toString();
    const gatewayUrl = new URL(paymentUrl);

    if (
        gatewayUrl.hostname !== 'sandbox.vnpayment.vn' ||
        gatewayUrl.pathname !== '/paymentv2/vpcpay.html' ||
        gatewayUrl.port !== '' ||
        gatewayUrl.username !== '' ||
        gatewayUrl.password !== '' ||
        gatewayUrl.search !== '' ||
        gatewayUrl.hash !== ''
    ) {
        throw new Error('Invalid VNPay Sandbox payment URL configuration.');
    }

    const returnUrl = requireReturnUrl(requireEnv('VNPAY_RETURN_URL'));

    return {
        tmnCode,
        hashSecret,
        paymentUrl,
        returnUrl
    };
}