import * as vscode from 'vscode';
import * as https from 'https';
import { TopazTreeProvider } from './TopazTreeProvider';
import { TopazServiceTypeTreeProvider } from './TopazServiceTypeTreeProvider';

const DOCS_URL = 'https://topaz.thecloudtheory.com/docs/intro/';

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
