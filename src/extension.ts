import * as vscode from 'vscode';
import * as https from 'https';
import { TopazTreeProvider } from './TopazTreeProvider';

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

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('topazResources', provider),
        vscode.commands.registerCommand('topaz.refresh', async () => {
            provider.setBaseUrl(getBaseUrl());
            await runHealthCheck(provider);
            provider.refresh();
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('topaz.baseUrl')) {
                provider.setBaseUrl(getBaseUrl());
                provider.refresh();
            }
        })
    );

    await runHealthCheck(provider);
}

async function runHealthCheck(provider: TopazTreeProvider): Promise<void> {
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
    } else {
        provider.setAvailable(true);
    }
    provider.refresh();
}

export function deactivate(): void { /* nothing */ }
