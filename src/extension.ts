import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import { TopazTreeProvider } from './TopazTreeProvider';
import { TopazServiceTypeTreeProvider } from './TopazServiceTypeTreeProvider';
import { TopazNode } from './TopazTreeProvider';
import { generateAdminToken } from './auth';

const DOCS_URL = 'https://topaz.thecloudtheory.com/docs/intro/';

function apiRequest(method: string, baseUrl: string, path: string, body?: unknown): Promise<void> {
    const token = generateAdminToken(baseUrl);
    const url = new URL(`${baseUrl}${path}`);
    const bodyData = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: false,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}),
        },
    };
    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            res.resume();
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                } else {
                    resolve();
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        if (bodyData) { req.write(bodyData); }
        req.end();
    });
}

function getBaseUrl(): string {
    return vscode.workspace.getConfiguration('topaz').get<string>('baseUrl', 'https://topaz.local.dev:8899');
}

function checkHealth(baseUrl: string): Promise<boolean> {
    return new Promise(resolve => {
        const req = https.get(`${baseUrl}/health`, { rejectUnauthorized: false }, res => {
            resolve(res.statusCode === 200);
            res.resume();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const provider = new TopazTreeProvider(getBaseUrl);
    const serviceTypeProvider = new TopazServiceTypeTreeProvider(getBaseUrl);

    const treeView = vscode.window.createTreeView('topazResources', { treeDataProvider: provider });
    provider.setTreeView(treeView);

    const serviceTypeView = vscode.window.createTreeView('topazByServiceType', { treeDataProvider: serviceTypeProvider });
    serviceTypeProvider.setTreeView(serviceTypeView);

    context.subscriptions.push(
        treeView,
        serviceTypeView,
        vscode.commands.registerCommand('topaz.refresh', async () => {
            provider.setBaseUrl(getBaseUrl());
            serviceTypeProvider.setBaseUrl(getBaseUrl());
            await runHealthCheck(provider, serviceTypeProvider);
            provider.refresh();
            serviceTypeProvider.refresh();
        }),
        vscode.commands.registerCommand('topaz.createManagementGroup', async (node?: TopazNode) => {
            const parentName = node ? node.id.split('/').pop()! : '50717675-3E5E-4A1E-8CB5-C62D8BE8CA48';
            const name = await vscode.window.showInputBox({ prompt: 'Management group name (ID)', placeHolder: 'my-management-group' });
            if (!name) { return; }
            const displayName = await vscode.window.showInputBox({ prompt: 'Display name', value: name });
            if (displayName === undefined) { return; }
            try {
                await apiRequest('PUT', getBaseUrl(),
                    `/providers/Microsoft.Management/managementGroups/${name}?api-version=2020-05-01`,
                    { properties: { displayName, details: { parent: { id: `/providers/Microsoft.Management/managementGroups/${parentName}` } } } }
                );
                provider.refresh();
                serviceTypeProvider.refresh();
            } catch (e: unknown) {
                vscode.window.showErrorMessage(`Failed to create management group: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('topaz.createSubscription', async (node?: TopazNode) => {
            const mgName = node ? node.id.split('/').pop()! : '50717675-3E5E-4A1E-8CB5-C62D8BE8CA48';
            const displayName = await vscode.window.showInputBox({ prompt: 'Subscription display name', placeHolder: 'my-subscription' });
            if (!displayName) { return; }
            const subscriptionId = crypto.randomUUID();
            try {
                await apiRequest('POST', getBaseUrl(),
                    `/subscriptions/${subscriptionId}`,
                    { SubscriptionName: displayName, SubscriptionId: subscriptionId }
                );
                await apiRequest('PUT', getBaseUrl(),
                    `/providers/Microsoft.Management/managementGroups/${mgName}/subscriptions/${subscriptionId}?api-version=2020-05-01`,
                    {}
                );
                provider.refresh();
                serviceTypeProvider.refresh();
            } catch (e: unknown) {
                vscode.window.showErrorMessage(`Failed to create subscription: ${(e as Error).message}`);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('topaz.baseUrl')) {
                provider.setBaseUrl(getBaseUrl());
                serviceTypeProvider.setBaseUrl(getBaseUrl());
                provider.refresh();
                serviceTypeProvider.refresh();
            }
        })
    );

    await runHealthCheck(provider, serviceTypeProvider);
}

async function runHealthCheck(provider: TopazTreeProvider, serviceTypeProvider: TopazServiceTypeTreeProvider): Promise<void> {
    const baseUrl = getBaseUrl();
    const healthy = await checkHealth(baseUrl);

    if (!healthy) {
        const choice = await vscode.window.showErrorMessage(
            `Topaz is not running at ${baseUrl}. Make sure it is started before using this extension.`,
            'Open Docs'
        );
        if (choice === 'Open Docs') {
            vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
        }
        provider.setAvailable(false);
        serviceTypeProvider.setAvailable(false);
    } else {
        provider.setAvailable(true);
        serviceTypeProvider.setAvailable(true);
    }
    provider.refresh();
    serviceTypeProvider.refresh();
}

export function deactivate(): void { /* nothing */ }
