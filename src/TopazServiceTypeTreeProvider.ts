import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';

function generateAdminToken(baseUrl: string): string {
    const secretB64 = 'yD1sMV1WcwVjSfNUxxLNfVHn5sbqD056LwOnkXCkIDnWkXcrg95plLQ3T1tvinLAnuNNiRRZrKyUvs6YzZnJ/A==';
    const secret = Buffer.from(secretB64, 'utf8');
    const oid = '00000000-0000-0000-0000-000000000000';
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        sub: oid, oid, appid: oid, azp: oid,
        tid: '50717675-3E5E-4A1E-8CB5-C62D8BE8CA48',
        iss: baseUrl,
        aud: baseUrl,
        nbf: now, iat: now, exp: now + 3600,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
}

export type ServiceTypeNodeKind = 'serviceType' | 'resource';

export interface ServiceTypeNode {
    kind: ServiceTypeNodeKind;
    id: string;
    label: string;
    description?: string;
    /** For resource nodes: the full resource id */
    resourceId?: string;
}

export class TopazServiceTypeTreeProvider implements vscode.TreeDataProvider<ServiceTypeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ServiceTypeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private available = false;
    private baseUrl: string;
    private treeView?: vscode.TreeView<ServiceTypeNode>;

    /** Cached flat list of all resources, populated on first root load */
    private resourcesByType: Map<string, Array<{ id: string; name: string; type: string }>> | null = null;

    constructor(private getBaseUrl: () => string) {
        this.baseUrl = getBaseUrl();
    }

    setAvailable(v: boolean): void { this.available = v; }
    setBaseUrl(url: string): void { this.baseUrl = url; this.resourcesByType = null; }
    setTreeView(view: vscode.TreeView<ServiceTypeNode>): void { this.treeView = view; }
    refresh(): void { this.resourcesByType = null; this._onDidChangeTreeData.fire(); }

    getTreeItem(node: ServiceTypeNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'serviceType'
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.kind === 'serviceType' ? 'symbol-class' : 'symbol-misc');
        item.contextValue = node.kind;
        item.tooltip = node.resourceId ?? node.id;
        return item;
    }

    async getChildren(parent?: ServiceTypeNode): Promise<ServiceTypeNode[]> {
        if (!this.available) {
            if (this.treeView) { this.treeView.message = 'Topaz is not running or unreachable.'; }
            return [];
        }

        try {
            if (!parent) {
                return await this.getServiceTypeNodes();
            }
            if (parent.kind === 'serviceType') {
                return (this.resourcesByType?.get(parent.id) ?? []).map(r => ({
                    kind: 'resource' as ServiceTypeNodeKind,
                    id: r.id,
                    label: r.name,
                    description: r.id.split('/resourceGroups/')[1]?.split('/')[0],
                    resourceId: r.id,
                }));
            }
            return [];
        } catch (e: unknown) {
            if (this.treeView && !parent) {
                const status = (e as { statusCode?: number }).statusCode;
                this.treeView.message = status === 401
                    ? 'Unauthorized. Make sure you are logged in to Azure CLI (`az login`).'
                    : 'Failed to load resources. Check the Topaz output for details.';
            }
            return [];
        }
    }

    private async getServiceTypeNodes(): Promise<ServiceTypeNode[]> {
        if (!this.resourcesByType) {
            await this.loadAllResources();
        }
        if (this.treeView) {
            this.treeView.message = undefined;
        }
        const nodes: ServiceTypeNode[] = [];
        for (const [type, resources] of this.resourcesByType ?? []) {
            const shortType = type.split('/').slice(1).join('/') || type;
            nodes.push({
                kind: 'serviceType',
                id: type,
                label: shortType,
                description: `${resources.length} resource${resources.length !== 1 ? 's' : ''}`,
            });
        }
        return nodes.sort((a, b) => a.label.localeCompare(b.label));
    }

    private async loadAllResources(): Promise<void> {
        const map = new Map<string, Array<{ id: string; name: string; type: string }>>();

        // Always seed from tenant-level providers (works even with no subscriptions)
        try {
            const providersRes = await this.get<{ value: Array<{ namespace: string; resourceTypes: Array<{ resourceType: string }> }> }>(
                '/providers?api-version=2021-04-01'
            );
            for (const provider of providersRes.value ?? []) {
                for (const rt of provider.resourceTypes ?? []) {
                    const t = `${provider.namespace}/${rt.resourceType}`.toLowerCase();
                    if (!map.has(t)) { map.set(t, []); }
                }
            }
        } catch {
            // fall through to subscription-level fetch
        }

        const subsRes = await this.get<{ value: Array<{ subscriptionId: string }> }>(
            '/subscriptions?api-version=2022-12-01'
        );
        const subs = subsRes.value ?? [];

        await Promise.all(subs.map(async sub => {
            try {
                // Seed map with subscription-scoped registered resource types
                const providersRes = await this.get<{ value: Array<{ namespace: string; resourceTypes: Array<{ resourceType: string }> }> }>(
                    `/subscriptions/${sub.subscriptionId}/providers?api-version=2021-04-01`
                );
                for (const provider of providersRes.value ?? []) {
                    for (const rt of provider.resourceTypes ?? []) {
                        const t = `${provider.namespace}/${rt.resourceType}`.toLowerCase();
                        if (!map.has(t)) { map.set(t, []); }
                    }
                }

                // Overlay with actual resource instances
                const res = await this.get<{ value: Array<{ id: string; name: string; type: string }> }>(
                    `/subscriptions/${sub.subscriptionId}/resources?api-version=2021-04-01`
                );
                for (const r of res.value ?? []) {
                    const t = r.type.toLowerCase();
                    if (!map.has(t)) { map.set(t, []); }
                    map.get(t)!.push(r);
                }
            } catch {
                // skip subscriptions that fail
            }
        }));

        this.resourcesByType = map;
    }

    private get<T>(path: string): Promise<T> {
        const token = generateAdminToken(this.baseUrl);
        const url = new URL(`${this.baseUrl}${path}`);
        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET',
            rejectUnauthorized: false,
            headers: { Authorization: `Bearer ${token}` },
        };
        return new Promise((resolve, reject) => {
            const req = https.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
                        return;
                    }
                    try { resolve(JSON.parse(data) as T); }
                    catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
        });
    }
}
