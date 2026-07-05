import * as crypto from 'crypto';

// C# `"..."u8.ToArray()` produces UTF-8 bytes of the string itself, not base64-decoded bytes
const SECRET = Buffer.from('yD1sMV1WcwVjSfNUxxLNfVHn5sbqD056LwOnkXCkIDnWkXcrg95plLQ3T1tvinLAnuNNiRRZrKyUvs6YzZnJ/A==', 'utf8');

// Replicates JwtHelper.GenerateCliToken() from Topaz.Identity
export function generateAdminToken(baseUrl: string): string {
    const oid = '00000000-0000-0000-0000-000000000000';
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        sub: oid, oid, appid: oid, azp: oid,
        tid: '50717675-3E5E-4A1E-8CB5-C62D8BE8CA48',
        iss: baseUrl, aud: baseUrl,
        nbf: now, iat: now, exp: now + 3600,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
}
