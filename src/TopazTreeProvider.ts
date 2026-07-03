import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';

// Replicates JwtHelper.GenerateCliToken() from Topaz.Identity
function generateAdminToken(baseUrl: string): string {
    const secretB64 = 'yD1sMV1WcwVjSfNUxxLNfVHn5sbqD056LwOnkXCkIDnWkXcrg95plLQ3T1tvinLAnuNNiRRZrKyUvs6YzZnJ/A==';
    // C# `"..."u8.ToArray()` produces UTF-8 bytes of the string itself, not base64-decoded bytes
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
export type NodeKind = 'managementGroup' | 'subscription' | 'resourceGroup' | 'resource';

export interface TopazNode {
    kind: NodeKind;
    id: string;
    label: string;
    description?: string;
}

const ICONS: Record<NodeKind, string> = {
    managementGroup: 'organization',
    subscription: 'layers',
    resourceGroup: 'folder',
    resource: 'symbol-misc',
};

export class TopazTreeProvider implements vscode.TreeDataProvider<TopazNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TopazNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private available = false;
    private baseUrl: string;
    private treeView?: vscode.TreeView<TopazNode>;

    constructor(private getBaseUrl: () => string) {
        this.baseUrl = getBaseUrl();
    }

    setAvailable(v: boolean): void { this.available = v; }
    setBaseUrl(url: string): void { this.baseUrl = url; }
    setTreeView(view: vscode.TreeView<TopazNode>): void { this.treeView = view; }
    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(node: TopazNode): vscode.TreeItem {
        const item = new vscode.TreeItem(
            node.label,
            node.kind === 'resource'
                ? vscode.TreeItemCollapsibleState.None
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
        item.contextValue = node.kind;
        item.tooltip = node.id;
        return item;
    }

    async getChildren(parent?: TopazNode): Promise<TopazNode[]> {
        if (!this.available) {
            if (this.treeView) { this.treeView.message = 'Topaz is not running or unreachable.'; }
            return [];
        }

        try {
            if (!parent) {
                const nodes = await this.getManagementGroups();
                if (this.treeView) {
                    this.treeView.message = nodes.length === 0
                        ? 'No management groups found. Topaz may still be initializing.'
                        : undefined;
                }
                return nodes;
            }
            switch (parent.kind) {
                case 'managementGroup': return await this.getManagementGroupChildren(parent.id);
                case 'subscription':   return await this.getResourceGroups(parent.id);
                case 'resourceGroup':  return await this.getResources(parent.id);
                default: return [];
            }
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

    // ── API helpers ──────────────────────────────────────────────────────────

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

    private async getManagementGroups(): Promise<TopazNode[]> {
        const res = await this.get<{ value: Array<{ id: string; name: string; properties?: { displayName?: string } }> }>(
            '/providers/Microsoft.Management/managementGroups?api-version=2020-05-01'
        );
        return (res.value ?? []).map(g => ({
            kind: 'managementGroup',
            id: g.id,
            label: g.properties?.displayName ?? g.name,
        }));
    }

    private async getManagementGroupChildren(mgId: string): Promise<TopazNode[]> {
        // mgId is the full path like /providers/Microsoft.Management/managementGroups/{name}
        const name = mgId.split('/').pop()!;
        const res = await this.get<{
            properties?: {
                children?: Array<{ id: string; name: string; type: string; displayName?: string }>;
            };
        }>(`/providers/Microsoft.Management/managementGroups/${name}?api-version=2020-05-01&$expand=children`);

        const children = res.properties?.children ?? [];
        return children.map(c => {
            const isSub = c.type === '/subscriptions';
            return {
                kind: isSub ? 'subscription' : 'managementGroup',
                id: c.id,
                label: c.displayName ?? c.name,
                description: isSub ? 'subscription' : undefined,
            } as TopazNode;
        });
    }

    private async getResourceGroups(subscriptionId: string): Promise<TopazNode[]> {
        // subscriptionId may be full path /subscriptions/{id} or just the guid
        const id = subscriptionId.replace(/^\/subscriptions\//, '');
        const res = await this.get<{ value: Array<{ id: string; name: string; location: string }> }>(
            `/subscriptions/${id}/resourcegroups?api-version=2021-04-01`
        );
        return (res.value ?? []).map(rg => ({
            kind: 'resourceGroup',
            id: rg.id,
            label: rg.name,
            description: rg.location,
        }));
    }

    private async getResources(rgId: string): Promise<TopazNode[]> {
        // rgId: /subscriptions/{sub}/resourceGroups/{rg}
        const res = await this.get<{ value: Array<{ id: string; name: string; type: string }> }>(
            `${rgId}/resources?api-version=2021-04-01`
        );
        return (res.value ?? []).map(r => ({
            kind: 'resource',
            id: r.id,
            label: r.name,
            description: r.type.split('/').slice(1).join('/'),
        }));
    }
}
