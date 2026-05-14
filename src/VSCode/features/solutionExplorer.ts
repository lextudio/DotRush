import { Extensions } from '../extensions';
import { LanguageServerController } from '../controllers/languageServerController';
import { DotNetTaskProvider } from '../providers/dotnetTaskProvider';
import * as res from '../resources/constants';
import type { Dirent } from 'fs';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

type SolutionExplorerNodeType = 'solution' | 'project' | 'folder' | 'file' | 'dependencies' | 'properties' | 'dependencyGroup' | 'dependency';

interface SolutionExplorerNode {
    type: SolutionExplorerNodeType;
    label: string;
    description?: string;
    filePath?: string;
    parentPath?: string;
    openPath?: string;
    line?: number;
    children?: SolutionExplorerNode[];
}

interface SolutionExplorerDependencyGroup {
    name: string;
    items: SolutionExplorerDependencyItem[];
}

interface SolutionExplorerDependencyItem {
    name: string;
    version?: string;
    filePath?: string;
    targetPath?: string;
    line?: number;
}

class SolutionExplorerProvider implements vscode.TreeDataProvider<SolutionExplorerNode> {
    private readonly changed = new vscode.EventEmitter<SolutionExplorerNode | undefined | null | void>();

    public readonly onDidChangeTreeData = this.changed.event;

    public refresh(): void {
        this.changed.fire();
    }

    public getTreeItem(node: SolutionExplorerNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, this.getCollapsibleState(node));
        item.contextValue = this.getContextValue(node);

        if (node.filePath !== undefined) {
            item.resourceUri = vscode.Uri.file(node.filePath);
            item.tooltip = node.filePath;
            if (!this.isContainerNode(node)) {
                item.command = {
                    command: res.commandIdSolutionExplorerOpenItem,
                    title: 'Open',
                    arguments: [node]
                };
            }
        }
        item.description = this.getDescription(node);

        if (node.type === 'solution') {
            item.iconPath = new vscode.ThemeIcon(this.isActiveTarget(node.filePath) ? 'check' : 'file-submodule');
        } else if (node.type === 'project') {
            item.iconPath = this.getProjectIcon(node.filePath);
        } else if (node.type === 'dependencies') {
            item.iconPath = new vscode.ThemeIcon('references');
        } else if (node.type === 'properties') {
            item.iconPath = new vscode.ThemeIcon('settings-gear');
        } else if (node.type === 'dependencyGroup') {
            item.iconPath = new vscode.ThemeIcon('library');
        } else if (node.type === 'dependency') {
            item.iconPath = new vscode.ThemeIcon('symbol-reference');
        } else if (node.type === 'folder') {
            item.iconPath = new vscode.ThemeIcon('folder');
        } else if (node.type === 'file') {
            item.iconPath = new vscode.ThemeIcon('file');
        } else {
            item.iconPath = new vscode.ThemeIcon('folder');
        }

        return item;
    }

    private getProjectIcon(projectFile?: string): vscode.ThemeIcon {
        if (this.isActiveTarget(projectFile))
            return new vscode.ThemeIcon('check');

        if (projectFile !== undefined && path.extname(projectFile).toLowerCase() === '.csproj')
            return new vscode.ThemeIcon('folder-library');

        return new vscode.ThemeIcon('window');
    }

    public isContainerNode(node: SolutionExplorerNode): boolean {
        return node.type === 'folder'
            || node.type === 'dependencies'
            || node.type === 'properties'
            || node.type === 'dependencyGroup';
    }

    public async getChildren(node?: SolutionExplorerNode): Promise<SolutionExplorerNode[]> {
        if (node?.type === 'project' && node.filePath !== undefined)
            return this.getProjectChildren(node.filePath);

        if (node?.type === 'folder' && node.filePath !== undefined && node.parentPath !== undefined)
            return this.getDirectoryChildren(node.filePath, node.parentPath);

        if (node?.type === 'dependencies' && node.filePath !== undefined)
            return this.getDependencyChildren(node.filePath);

        if (node !== undefined)
            return node.children ?? [];

        const solutionFile = this.getActiveSolutionFile();
        if (solutionFile === undefined)
            return [];

        const projectFiles = await Extensions.getProjectFiles();
        const children = await this.getSolutionProjects(solutionFile, projectFiles);
        return [{
            type: 'solution',
            label: path.basename(solutionFile),
            filePath: solutionFile,
            children: children
        }];
    }

    private getCollapsibleState(node: SolutionExplorerNode): vscode.TreeItemCollapsibleState {
        if (node.type === 'project' || node.type === 'folder' || node.type === 'dependencies')
            return vscode.TreeItemCollapsibleState.Collapsed;

        if (node.children === undefined || node.children.length === 0)
            return vscode.TreeItemCollapsibleState.None;

        return vscode.TreeItemCollapsibleState.Expanded;
    }

    private getContextValue(node: SolutionExplorerNode): string {
        if (node.type === 'folder')
            return 'dotrushSolutionExplorerFolder';

        if (node.type === 'file')
            return 'dotrushSolutionExplorerFile';

        if (node.type === 'dependencies')
            return 'dotrushSolutionExplorerDependencies';

        if (node.type === 'properties')
            return 'dotrushSolutionExplorerProperties';

        if (node.type === 'dependencyGroup')
            return 'dotrushSolutionExplorerDependencyGroup';

        if (node.type === 'dependency')
            return 'dotrushSolutionExplorerDependency';

        return this.isActiveTarget(node.filePath)
            ? `dotrushSolutionExplorer${Extensions.capitalize(node.type)}Active`
            : `dotrushSolutionExplorer${Extensions.capitalize(node.type)}`;
    }

    private getDescription(node: SolutionExplorerNode): string {
        if (node.filePath === undefined)
            return '';

        if ((node.type === 'solution' || node.type === 'project') && this.isActiveTarget(node.filePath))
            return 'active';

        return node.description ?? '';
    }

    private isActiveTarget(filePath?: string): boolean {
        if (filePath === undefined)
            return false;

        const activeTargets = Extensions.getSetting<string[]>(res.configIdRoslynProjectOrSolutionFiles, []);
        return activeTargets?.some(target => path.normalize(target) === path.normalize(filePath)) ?? false;
    }

    private getActiveSolutionFile(): string | undefined {
        const activeTargets = Extensions.getSetting<string[]>(res.configIdRoslynProjectOrSolutionFiles, []);
        return activeTargets?.find(target => Extensions.isSolutionFile(target));
    }

    private async getSolutionProjects(solutionFile: string, workspaceProjects: string[]): Promise<SolutionExplorerNode[]> {
        const solutionDirectory = path.dirname(solutionFile);
        const knownProjects = new Set(workspaceProjects.map(projectFile => path.normalize(projectFile)));
        const content = await this.tryReadFile(solutionFile);
        if (content === undefined)
            return [];

        const extension = path.extname(solutionFile).toLowerCase();
        if (extension === '.slnx')
            return this.getSlnxProjects(content, solutionDirectory, knownProjects);

        if (extension !== '.sln')
            return [];

        const nodes: SolutionExplorerNode[] = [];
        const projectEntryPattern = /^Project\("[^"]+"\)\s*=\s*"([^"]+)",\s*"([^"]+\.(?:csproj|fsproj|vbproj))",\s*"[^"]+"/gmi;
        let match: RegExpExecArray | null;
        while ((match = projectEntryPattern.exec(content)) !== null) {
            const projectPath = path.resolve(solutionDirectory, match[2]);
            if (!knownProjects.has(path.normalize(projectPath)))
                continue;

            nodes.push({
                type: 'project',
                label: match[1],
                filePath: projectPath
            });
        }

        return nodes.sort((a, b) => a.label.localeCompare(b.label));
    }

    private getSlnxProjects(content: string, solutionDirectory: string, knownProjects: Set<string>): SolutionExplorerNode[] {
        const nodes: SolutionExplorerNode[] = [];
        const projectEntryPattern = /<Project\b[^>]*\bPath="([^"]+\.(?:csproj|fsproj|vbproj))"[^>]*>/gi;
        let match: RegExpExecArray | null;
        while ((match = projectEntryPattern.exec(content)) !== null) {
            const projectPath = path.resolve(solutionDirectory, match[1]);
            if (!knownProjects.has(path.normalize(projectPath)))
                continue;

            nodes.push({
                type: 'project',
                label: path.basename(projectPath, path.extname(projectPath)),
                filePath: projectPath
            });
        }

        return nodes.sort((a, b) => a.label.localeCompare(b.label));
    }

    private async getProjectChildren(projectFile: string): Promise<SolutionExplorerNode[]> {
        const projectDirectory = path.dirname(projectFile);
        const children: SolutionExplorerNode[] = [
            {
                type: 'dependencies',
                label: 'Dependencies',
                filePath: projectFile
            }
        ];

        const propertiesDirectory = path.join(projectDirectory, 'Properties');
        if (await this.directoryExists(propertiesDirectory)) {
            children.push({
                type: 'properties',
                label: 'Properties',
                children: await this.getDirectoryChildren(propertiesDirectory, projectDirectory)
            });
        }

        children.push(...await this.getDirectoryChildren(projectDirectory, projectDirectory, new Set(['Properties'])));
        return children;
    }

    private async getDependencyChildren(projectFile: string): Promise<SolutionExplorerNode[]> {
        const groups = await LanguageServerController.sendRequest<SolutionExplorerDependencyGroup[]>('dotrush/solutionExplorer/dependencies', { projectPath: projectFile });
        if (groups !== undefined)
            return groups
                .filter(group => group.items.length > 0)
                .map(group => this.createDependencyGroup(group.name, group.items.map(item => ({
                    type: 'dependency',
                    label: item.name,
                    description: item.version,
                    filePath: item.targetPath ?? item.filePath,
                    openPath: item.filePath,
                    line: item.line
                }))));

        const content = await this.tryReadFile(projectFile);
        if (content === undefined)
            return [];

        const projectDirectory = path.dirname(projectFile);
        const fallbackGroups = [
            this.createDependencyGroup('Projects', this.getProjectReferences(content, projectDirectory)),
            this.createDependencyGroup('Packages', this.getPackageReferences(content, projectFile)),
            this.createDependencyGroup('Analyzers', this.getAnalyzerReferences(content, projectDirectory))
        ];

        return fallbackGroups.filter(group => group.children !== undefined && group.children.length > 0);
    }

    private createDependencyGroup(label: string, children: SolutionExplorerNode[]): SolutionExplorerNode {
        return {
            type: 'dependencyGroup',
            label: label,
            children: children.sort((a, b) => a.label.localeCompare(b.label))
        };
    }

    private getProjectReferences(content: string, projectDirectory: string): SolutionExplorerNode[] {
        const references = this.getXmlElementAttributes(content, 'ProjectReference');
        return references.map(reference => {
            const include = reference.attributes.get('Include') ?? '';
            const referencePath = path.resolve(projectDirectory, include);
            return {
                type: 'dependency',
                label: path.basename(referencePath, path.extname(referencePath)),
                filePath: referencePath,
                openPath: path.join(projectDirectory, path.basename(projectDirectory) + '.csproj'),
                line: reference.line
            };
        });
    }

    private getPackageReferences(content: string, projectFile: string): SolutionExplorerNode[] {
        const packageVersions = this.getCentralPackageVersions(projectFile);
        return this.getXmlElementAttributes(content, 'PackageReference').map(reference => {
            const include = reference.attributes.get('Include') ?? reference.attributes.get('Update');
            const version = reference.attributes.get('Version') ?? this.getChildElementValue(reference.innerXml, 'Version') ?? packageVersions.get(include ?? '');
            return {
                type: 'dependency',
                label: include ?? 'Package',
                description: version,
                openPath: projectFile,
                line: reference.line
            };
        });
    }

    private getAnalyzerReferences(content: string, projectDirectory: string): SolutionExplorerNode[] {
        return this.getXmlElementAttributes(content, 'Analyzer').map(reference => {
            const include = reference.attributes.get('Include') ?? '';
            const referencePath = path.resolve(projectDirectory, include);
            return {
                type: 'dependency',
                label: path.basename(referencePath),
                filePath: referencePath,
                openPath: path.join(projectDirectory, path.basename(projectDirectory) + '.csproj'),
                line: reference.line
            };
        });
    }

    private getXmlAttributeValues(content: string, elementName: string, attributeName: string): string[] {
        return this.getXmlElementAttributes(content, elementName)
            .map(element => element.attributes.get(attributeName))
            .filter((value): value is string => value !== undefined);
    }

    private getXmlElementAttributes(content: string, elementName: string): { attributes: Map<string, string>; innerXml: string; line: number }[] {
        const elements = new RegExp(`<${elementName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${elementName}>)`, 'gi');
        const result: { attributes: Map<string, string>; innerXml: string; line: number }[] = [];
        let elementMatch: RegExpExecArray | null;
        while ((elementMatch = elements.exec(content)) !== null) {
            const attributes = new Map<string, string>();
            const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
            let attributeMatch: RegExpExecArray | null;
            while ((attributeMatch = attributePattern.exec(elementMatch[1])) !== null)
                attributes.set(attributeMatch[1], attributeMatch[2]);

            result.push({
                attributes: attributes,
                innerXml: elementMatch[2] ?? '',
                line: this.getLineNumber(content, elementMatch.index)
            });
        }

        return result;
    }

    private getChildElementValue(content: string, elementName: string): string | undefined {
        const match = new RegExp(`<${elementName}\\b[^>]*>([^<]*)</${elementName}>`, 'i').exec(content);
        return match?.[1]?.trim();
    }

    private getCentralPackageVersions(projectFile: string): Map<string, string> {
        const versions = new Map<string, string>();
        let directory = path.dirname(projectFile);
        while (true) {
            const propsFile = path.join(directory, 'Directory.Packages.props');
            const content = this.tryReadFileSync(propsFile);
            if (content !== undefined) {
                for (const packageVersion of this.getXmlElementAttributes(content, 'PackageVersion')) {
                    const include = packageVersion.attributes.get('Include') ?? packageVersion.attributes.get('Update');
                    const version = packageVersion.attributes.get('Version') ?? this.getChildElementValue(packageVersion.innerXml, 'Version');
                    if (include !== undefined && version !== undefined)
                        versions.set(include, version);
                }
            }

            const parent = path.dirname(directory);
            if (parent === directory)
                return versions;

            directory = parent;
        }
    }

    private tryReadFileSync(filePath: string): string | undefined {
        try {
            return fsSync.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }
    }

    private getLineNumber(content: string, index: number): number {
        return content.slice(0, index).split(/\r\n|\r|\n/).length - 1;
    }

    private async tryReadFile(filePath: string): Promise<string | undefined> {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch {
            return undefined;
        }
    }

    private async getDirectoryChildren(directoryPath: string, rootPath: string, excludedNames: Set<string> = new Set()): Promise<SolutionExplorerNode[]> {
        const entries = await this.tryReadDirectory(directoryPath);
        const nodes = entries
            .filter(entry => !excludedNames.has(entry.name) && this.shouldShowEntry(entry.name))
            .map(entry => {
                const entryPath = path.join(directoryPath, entry.name);
                return {
                    type: entry.isDirectory() ? 'folder' as const : 'file' as const,
                    label: entry.name,
                    filePath: entryPath,
                    parentPath: rootPath
                };
            });

        return nodes.sort((a, b) => {
            if (a.type !== b.type)
                return a.type === 'folder' ? -1 : 1;

            return a.label.localeCompare(b.label);
        });
    }

    private async tryReadDirectory(directoryPath: string): Promise<Dirent[]> {
        try {
            return await fs.readdir(directoryPath, { withFileTypes: true });
        } catch {
            return [];
        }
    }

    private shouldShowEntry(name: string): boolean {
        if (['.git', '.vs', 'bin', 'obj', 'node_modules'].includes(name))
            return false;

        return !Extensions.isProjectFile(name);
    }

    private async directoryExists(directoryPath: string): Promise<boolean> {
        try {
            return (await fs.stat(directoryPath)).isDirectory();
        } catch {
            return false;
        }
    }
}

export class SolutionExplorer {
    public static readonly feature = new SolutionExplorer();

    private readonly provider = new SolutionExplorerProvider();

    public activate(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.window.registerTreeDataProvider(res.solutionExplorerViewId, this.provider));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerOpenSolution, async () => {
            const selectedFiles = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Solutions': ['sln', 'slnx']
                },
                openLabel: 'Open Solution'
            });
            const solutionFile = selectedFiles?.at(0)?.fsPath;
            if (solutionFile === undefined)
                return;

            await Extensions.putSetting(res.configIdRoslynProjectOrSolutionFiles, [solutionFile], vscode.ConfigurationTarget.Workspace);
            vscode.commands.executeCommand(res.commandIdReloadWorkspace);
            this.provider.refresh();
        }));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerRefresh, () => this.provider.refresh()));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerBuildProject, async (node?: SolutionExplorerNode) => {
            if (node?.filePath !== undefined)
                vscode.tasks.executeTask(DotNetTaskProvider.getBuildTask(node.filePath));
        }));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerRebuildProject, async (node?: SolutionExplorerNode) => {
            if (node?.filePath !== undefined)
                vscode.tasks.executeTask(DotNetTaskProvider.getRebuildTask(node.filePath));
        }));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerCleanProject, async (node?: SolutionExplorerNode) => {
            if (node?.filePath !== undefined)
                vscode.tasks.executeTask(DotNetTaskProvider.getCleanTask(node.filePath));
        }));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerSetWorkspaceTarget, async (node?: SolutionExplorerNode) => {
            const targetPath = node?.filePath;
            if (targetPath === undefined)
                return;

            await Extensions.putSetting(res.configIdRoslynProjectOrSolutionFiles, [targetPath], vscode.ConfigurationTarget.Workspace);
            vscode.commands.executeCommand(res.commandIdReloadWorkspace);
            this.provider.refresh();
        }));
        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdSolutionExplorerOpenItem, async (node?: SolutionExplorerNode) => {
            if (node === undefined || this.provider.isContainerNode(node))
                return;

            const targetPath = node.openPath ?? node.filePath;
            if (targetPath === undefined)
                return;

            const options: vscode.TextDocumentShowOptions = { preview: true };
            if (node.line !== undefined)
                options.selection = new vscode.Range(node.line, 0, node.line, 0);

            await vscode.window.showTextDocument(vscode.Uri.file(targetPath), options);
        }));
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`${res.extensionId}.${res.configIdRoslynProjectOrSolutionFiles}`))
                this.provider.refresh();
        }));
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.provider.refresh()));
    }
}
