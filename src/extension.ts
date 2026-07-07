import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as child_process from 'child_process';
import { TopazTreeProvider } from './TopazTreeProvider';
import { TopazServiceTypeTreeProvider } from './TopazServiceTypeTreeProvider';
import { TopazStatusProvider } from './TopazStatusProvider';
import { TopazDeploymentsProvider } from './TopazDeploymentsProvider';
import { TopazNode } from './TopazTreeProvider';
import { generateAdminToken } from './auth';

const DOCS_URL = 'https://topaz.thecloudtheory.com/docs/intro/';

let logChannel: vscode.OutputChannel | undefined;
let logCleanup: (() => void) | undefined;

function startLogStreaming(): void {
    stopLogStreaming();
    const cfg = vscode.workspace.getConfiguration('topaz');
    const source = cfg.get<string>('logSource', 'none');
    if (source === 'none') { return; }

    if (!logChannel) {
        logChannel = vscode.window.createOutputChannel('Topaz Logs');
    }
    logChannel.show(true);

    if (source === 'file') {
        const logFile = cfg.get<string>('logFile', '');
        if (!logFile) {
            logChannel.appendLine('[Topaz] topaz.logFile is not configured.');
            return;
        }
        let pos = 0;
        try { pos = fs.statSync(logFile).size; } catch { /* file may not exist yet */ }
        const watcher = fs.watch(logFile, () => {
            try {
                const size = fs.statSync(logFile).size;
                if (size <= pos) { return; }
                const buf = Buffer.alloc(size - pos);
                const fd = fs.openSync(logFile, 'r');
                fs.readSync(fd, buf, 0, buf.length, pos);
                fs.closeSync(fd);
                pos = size;
                logChannel!.append(buf.toString('utf8'));
            } catch { /* ignore transient errors */ }
        });
        logCleanup = () => watcher.close();
    } else if (source === 'docker') {
        const name = cfg.get<string>('containerName', 'topaz.local.dev');
        const proc = child_process.spawn('docker', ['logs', '-f', '--tail', '100', name]);
        proc.stdout.on('data', (d: Buffer) => logChannel!.append(d.toString()));
        proc.stderr.on('data', (d: Buffer) => logChannel!.append(d.toString()));
        proc.on('error', (e: Error) => logChannel!.appendLine(`[Topaz] docker logs error: ${e.message}`));
        logCleanup = () => proc.kill();
    }
}

function stopLogStreaming(): void {
    if (logCleanup) { logCleanup(); logCleanup = undefined; }
}

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

async function compileToArmJson(doc: vscode.TextDocument): Promise<string> {
    if (doc.languageId !== 'bicep') {
        return doc.getText();
    }

    // Write current in-memory content to a temp file so unsaved changes are included
    const os = await import('os');
    const path = await import('path');
    const tmpFile = path.join(os.tmpdir(), `topaz-deploy-${Date.now()}.bicep`);
    fs.writeFileSync(tmpFile, doc.getText(), 'utf8');

    return new Promise((resolve, reject) => {
        const proc = child_process.spawn('az', ['bicep', 'build', '--file', tmpFile, '--stdout']);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
        proc.on('error', (e) => { fs.unlink(tmpFile, () => {}); reject(e); });
        proc.on('close', code => {
            fs.unlink(tmpFile, () => {});
            if (code !== 0) {
                reject(new Error(err || 'bicep build failed'));
            } else {
                // Strip any non-JSON prefix/suffix (warnings/progress lines emitted to stdout)
                const jsonStart = out.indexOf('{');
                const jsonEnd = out.lastIndexOf('}');
                if (jsonStart >= 0 && jsonEnd > jsonStart) {
                    resolve(out.slice(jsonStart, jsonEnd + 1));
                } else {
                    reject(new Error('bicep build produced no JSON output'));
                }
            }
        });
    });
}

type DeployScope = 'resourceGroup' | 'subscription' | 'managementGroup' | 'tenant';

function detectScope(templateJson: string, doc: vscode.TextDocument): DeployScope {
    if (doc.languageId === 'bicep') {
        const match = doc.getText().match(/^\s*targetScope\s*=\s*'([^']+)'/m);
        if (match) {
            const s = match[1];
            if (s === 'subscription') { return 'subscription'; }
            if (s === 'managementGroup') { return 'managementGroup'; }
            if (s === 'tenant') { return 'tenant'; }
        }
        return 'resourceGroup';
    }
    // ARM JSON — check $schema
    const schemaMatch = templateJson.match(/"\\?\$schema"\s*:\s*"([^"]+)"/);
    const schema = schemaMatch ? schemaMatch[1] : '';
    if (schema.includes('subscriptionDeploymentTemplate')) { return 'subscription'; }
    if (schema.includes('managementGroupDeploymentTemplate')) { return 'managementGroup'; }
    if (schema.includes('tenantDeploymentTemplate')) { return 'tenant'; }
    return 'resourceGroup';
}

async function deployTemplate(doc: vscode.TextDocument): Promise<boolean> {
    const baseUrl = getBaseUrl();

    // Compile first so we can detect scope for Bicep (or validate JSON early)
    let templateJson: string;
    try {
        templateJson = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: doc.languageId === 'bicep' ? 'Compiling Bicep template…' : 'Reading template…', cancellable: false },
            () => compileToArmJson(doc)
        );
    } catch (e: unknown) {
        vscode.window.showErrorMessage(`Bicep compile failed: ${(e as Error).message}`);
        return false;
    }

    let template: unknown;
    try {
        template = JSON.parse(templateJson);
    } catch {
        vscode.window.showErrorMessage('File is not valid JSON.');
        return false;
    }

    const scope = detectScope(templateJson, doc);

    // Optional parameters file
    let parameters: unknown | undefined;
    const paramChoice = await vscode.window.showQuickPick(
        [{ label: 'No parameters file', value: false }, { label: 'Select parameters file…', value: true }],
        { placeHolder: 'Provide a parameters file?' }
    );
    if (paramChoice === undefined) { return false; }
    if (paramChoice.value) {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Parameter files': ['json', 'bicepparam'] },
            title: 'Select ARM parameters file',
        });
        if (!uris || uris.length === 0) { return false; }
        const paramUri = uris[0];
        let paramJson: string;
        if (paramUri.fsPath.endsWith('.bicepparam')) {
            paramJson = await new Promise<string>((resolve, reject) => {
                const proc = child_process.spawn('az', ['bicep', 'build-params', '--file', paramUri.fsPath, '--stdout']);
                let out = ''; let err = '';
                proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
                proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
                proc.on('error', reject);
                proc.on('close', code => {
                    if (code !== 0) { reject(new Error(err || 'bicep build-params failed')); return; }
                    const s = out.indexOf('{'); const e = out.lastIndexOf('}');
                    if (s >= 0 && e > s) { resolve(out.slice(s, e + 1)); }
                    else { reject(new Error('bicep build-params produced no JSON output')); }
                });
            });
        } else {
            paramJson = fs.readFileSync(paramUri.fsPath, 'utf8');
        }
        try {
            const parsed = JSON.parse(paramJson) as { parametersJson?: unknown; parameters?: unknown };
            // az bicep build-params --stdout wraps in { parametersJson: "<json-string>", templateFilePath: "..." }
            // where parametersJson is a serialized string, not an object — parse it again if needed
            const raw = parsed.parametersJson ?? parsed.parameters ?? parsed;
            parameters = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            vscode.window.showErrorMessage('Parameters file is not valid JSON.');
            return false;
        }
    }

    const deploymentName = await vscode.window.showInputBox({
        prompt: 'Deployment name',
        value: `vscode-deploy-${Date.now()}`,
    });
    if (deploymentName === undefined) { return false; }

    let deployPath: string;

    if (scope === 'resourceGroup') {
        const subscriptionId = await pickSubscriptionId(baseUrl);
        if (!subscriptionId) { return false; }
        const resourceGroup = await vscode.window.showInputBox({
            prompt: 'Resource group name',
            placeHolder: 'my-resource-group',
            validateInput: v => v ? undefined : 'Required',
        });
        if (!resourceGroup) { return false; }
        deployPath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`;
    } else if (scope === 'subscription') {
        const subscriptionId = await pickSubscriptionId(baseUrl);
        if (!subscriptionId) { return false; }
        deployPath = `/subscriptions/${subscriptionId}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`;
    } else if (scope === 'managementGroup') {
        const mgId = await vscode.window.showInputBox({
            prompt: 'Management group ID',
            placeHolder: 'my-management-group',
            validateInput: v => v ? undefined : 'Required',
        });
        if (!mgId) { return false; }
        deployPath = `/providers/Microsoft.Management/managementGroups/${mgId}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`;
    } else {
        // tenant
        deployPath = `/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`;
    }

    return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deploying to Topaz (${scope})…`, cancellable: false },
        async () => {
            try {
                await apiRequest('PUT', baseUrl, deployPath, { properties: { mode: 'Incremental', template, ...(parameters ? { parameters } : {}) } });
                vscode.window.showInformationMessage(`Deployment '${deploymentName}' submitted to Topaz.`);
                return true;
            } catch (e: unknown) {
                vscode.window.showErrorMessage(`Deployment failed: ${(e as Error).message}`);
                return false;
            }
        }
    );
}

async function pickSubscriptionId(baseUrl: string): Promise<string | undefined> {
    const token = generateAdminToken(baseUrl);
    const url = new URL(`${baseUrl}/subscriptions?api-version=2022-12-01`);
    let subs: Array<{ subscriptionId: string; displayName: string }> = [];
    try {
        const res = await new Promise<{ value: Array<{ subscriptionId: string; displayName: string }> }>((resolve, reject) => {
            const req = https.request(
                { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', rejectUnauthorized: false, headers: { Authorization: `Bearer ${token}` } },
                res => {
                    let data = '';
                    res.on('data', (c: Buffer) => { data += c.toString(); });
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
                        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
        });
        subs = res.value ?? [];
    } catch { /* fall through to manual input */ }

    if (subs.length > 0) {
        const items = [
            ...subs.map(s => ({ label: s.displayName, description: s.subscriptionId, value: s.subscriptionId })),
            { label: '$(edit) Enter manually…', description: '', value: '' },
        ];
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a subscription' });
        if (picked === undefined) { return undefined; }
        if (picked.value) { return picked.value; }
    }

    return await vscode.window.showInputBox({
        prompt: 'Subscription ID',
        placeHolder: '00000000-0000-0000-0000-000000000000',
        validateInput: v => v ? undefined : 'Required',
    });
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
    const statusProvider = new TopazStatusProvider(getBaseUrl);
    const deploymentsProvider = new TopazDeploymentsProvider(getBaseUrl);

    const treeView = vscode.window.createTreeView('topazResources', { treeDataProvider: provider });
    provider.setTreeView(treeView);

    const serviceTypeView = vscode.window.createTreeView('topazByServiceType', { treeDataProvider: serviceTypeProvider });
    serviceTypeProvider.setTreeView(serviceTypeView);

    const deploymentsView = vscode.window.createTreeView('topazDeployments', { treeDataProvider: deploymentsProvider });
    deploymentsProvider.setTreeView(deploymentsView);
    vscode.window.createTreeView('topazStatus', { treeDataProvider: statusProvider });

    context.subscriptions.push(
        treeView,
        serviceTypeView,
        { dispose: () => statusProvider.dispose() },
        vscode.commands.registerCommand('topaz.deployTemplate', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const deployed = await deployTemplate(editor.document);
            if (deployed) {
                provider.refresh();
                serviceTypeProvider.refresh();
                deploymentsProvider.refresh();
            }
        }),
        deploymentsView,
        vscode.commands.registerCommand('topaz.refresh', async () => {
            provider.setBaseUrl(getBaseUrl());
            serviceTypeProvider.setBaseUrl(getBaseUrl());
            statusProvider.setBaseUrl(getBaseUrl());
            deploymentsProvider.setBaseUrl(getBaseUrl());
            runHealthCheck(provider, serviceTypeProvider, deploymentsProvider);
            provider.refresh();
            serviceTypeProvider.refresh();
            statusProvider.refresh();
            deploymentsProvider.refresh();
        }),
        vscode.commands.registerCommand('topaz.refreshStatus', () => { statusProvider.refresh(); }),
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
        vscode.commands.registerCommand('topaz.copySubscriptionId', async (node?: TopazNode) => {
            if (!node) { return; }
            const id = node.id.replace(/^\/subscriptions\//, '');
            await vscode.env.clipboard.writeText(id);
            vscode.window.showInformationMessage(`Copied subscription ID: ${id}`);
        }),
        vscode.commands.registerCommand('topaz.createResourceGroup', async (node?: TopazNode) => {
            if (!node) { return; }
            const subscriptionId = node.id.replace(/^\/subscriptions\//, '');
            const name = await vscode.window.showInputBox({ prompt: 'Resource group name', placeHolder: 'my-resource-group' });
            if (!name) { return; }
            const location = await vscode.window.showInputBox({ prompt: 'Location', value: 'westeurope' });
            if (location === undefined) { return; }
            try {
                await apiRequest('PUT', getBaseUrl(),
                    `/subscriptions/${subscriptionId}/resourcegroups/${name}?api-version=2021-04-01`,
                    { location }
                );
                provider.refresh();
                serviceTypeProvider.refresh();
            } catch (e: unknown) {
                vscode.window.showErrorMessage(`Failed to create resource group: ${(e as Error).message}`);
            }
        }),
        vscode.commands.registerCommand('topaz.startStandalone', () => {
            const terminal = vscode.window.createTerminal('Topaz');
            terminal.show();
            terminal.sendText('topaz-host');
        }),
        vscode.commands.registerCommand('topaz.startDocker', async () => {
            const cfg = vscode.workspace.getConfiguration('topaz');
            const containerName = cfg.get<string>('containerName', 'topaz.local.dev');
            const image = cfg.get<string>('dockerImage', 'thecloudtheory/topaz-host:latest');
            const terminal = vscode.window.createTerminal('Topaz (Docker)');
            terminal.show();
            terminal.sendText(`docker run --rm -d --name ${containerName} -p 8899:8899 ${image}`);
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('topaz.baseUrl')) {
                provider.setBaseUrl(getBaseUrl());
                serviceTypeProvider.setBaseUrl(getBaseUrl());
                statusProvider.setBaseUrl(getBaseUrl());
                deploymentsProvider.setBaseUrl(getBaseUrl());
                provider.refresh();
                serviceTypeProvider.refresh();
                statusProvider.refresh();
                deploymentsProvider.refresh();
            }
            if (e.affectsConfiguration('topaz.logSource') ||
                e.affectsConfiguration('topaz.logFile') ||
                e.affectsConfiguration('topaz.containerName')) {
                startLogStreaming();
            }
        })
    );

    statusProvider.refresh();
    startLogStreaming();
    runHealthCheck(provider, serviceTypeProvider, deploymentsProvider);
}

async function runHealthCheck(provider: TopazTreeProvider, serviceTypeProvider: TopazServiceTypeTreeProvider, deploymentsProvider?: import('./TopazDeploymentsProvider').TopazDeploymentsProvider): Promise<void> {
    const baseUrl = getBaseUrl();
    const healthy = await checkHealth(baseUrl);

    if (!healthy) {
        vscode.window.showErrorMessage(
            `Topaz is not running at ${baseUrl}. Make sure it is started before using this extension.`,
            'Open Docs'
        ).then(choice => {
            if (choice === 'Open Docs') { vscode.env.openExternal(vscode.Uri.parse(DOCS_URL)); }
        });
        provider.setAvailable(false);
        serviceTypeProvider.setAvailable(false);
        deploymentsProvider?.setAvailable(false);
    } else {
        provider.setAvailable(true);
        serviceTypeProvider.setAvailable(true);
        deploymentsProvider?.setAvailable(true);
    }
    provider.refresh();
    serviceTypeProvider.refresh();
    deploymentsProvider?.refresh();
}

export function deactivate(): void {
    stopLogStreaming();
    logChannel?.dispose();
}
