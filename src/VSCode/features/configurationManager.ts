import { Extensions } from '../extensions';
import { Interop } from '../interop/interop';
import { StateController } from '../controllers/stateController';
import { StatusBarController } from '../controllers/statusbarController';
import * as res from '../resources/constants';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const defaultConfigurations = ['Debug', 'Release'];

interface ProjectConfigState {
    configuration?: string;
    framework?: string;
    build: boolean;
}

interface ConfigurationManagerNode {
    projectPath: string;
    projectName: string;
    state: ProjectConfigState;
}

class ConfigurationManagerProvider implements vscode.TreeDataProvider<ConfigurationManagerNode> {
    private readonly changed = new vscode.EventEmitter<ConfigurationManagerNode | undefined | null | void>();
    public readonly onDidChangeTreeData = this.changed.event;

    public refresh(): void {
        this.changed.fire();
    }

    public getTreeItem(node: ConfigurationManagerNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.projectName, vscode.TreeItemCollapsibleState.None);
        item.resourceUri = vscode.Uri.file(node.projectPath);
        item.tooltip = node.projectPath;
        item.contextValue = node.state.build
            ? 'dotrushConfigurationManagerProject'
            : 'dotrushConfigurationManagerProjectExcluded';

        const config = node.state.configuration ?? StatusBarController.activeConfiguration ?? 'Debug';
        const framework = node.state.framework ?? StatusBarController.activeFramework;
        item.description = framework !== undefined ? `${config} | ${framework}` : config;
        item.iconPath = node.state.build
            ? new vscode.ThemeIcon('settings-gear')
            : new vscode.ThemeIcon('eye-closed');

        return item;
    }

    public async getChildren(node?: ConfigurationManagerNode): Promise<ConfigurationManagerNode[]> {
        if (node !== undefined)
            return [];

        const solutionFile = this.getActiveSolutionFile();
        if (solutionFile === undefined)
            return [];

        const projectFiles = await Extensions.getProjectFiles();
        const projectPaths = await this.getProjectPathsFromSolution(solutionFile, projectFiles);
        const savedStates = ConfigurationManager.getAllProjectStates();

        return projectPaths.map(projectPath => ({
            projectPath,
            projectName: path.basename(projectPath, path.extname(projectPath)),
            state: savedStates[projectPath] ?? { build: true }
        })).sort((a, b) => a.projectName.localeCompare(b.projectName));
    }

    private getActiveSolutionFile(): string | undefined {
        const activeTargets = Extensions.getSetting<string[]>(res.configIdRoslynProjectOrSolutionFiles, []);
        return activeTargets?.find(target => Extensions.isSolutionFile(target));
    }

    private async getProjectPathsFromSolution(solutionFile: string, workspaceProjects: string[]): Promise<string[]> {
        const solutionDirectory = path.dirname(solutionFile);
        const knownProjects = new Set(workspaceProjects.map(p => path.normalize(p)));
        let content: string;
        try {
            content = await fs.readFile(solutionFile, 'utf8');
        } catch {
            return [];
        }

        const extension = path.extname(solutionFile).toLowerCase();
        const paths: string[] = [];

        if (extension === '.slnx') {
            const pattern = /<Project\b[^>]*\bPath="([^"]+\.(?:csproj|fsproj|vbproj))"[^>]*>/gi;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                const projectPath = path.resolve(solutionDirectory, match[1]);
                if (knownProjects.has(path.normalize(projectPath)))
                    paths.push(projectPath);
            }
        } else if (extension === '.sln') {
            const pattern = /^Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.(?:csproj|fsproj|vbproj))",\s*"[^"]+"/gmi;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                const projectPath = path.resolve(solutionDirectory, match[1]);
                if (knownProjects.has(path.normalize(projectPath)))
                    paths.push(projectPath);
            }
        }

        return paths;
    }
}

export class ConfigurationManager {
    public static readonly feature = new ConfigurationManager();

    private readonly provider = new ConfigurationManagerProvider();
    private static readonly stateKey = 'configManager.projects';

    public activate(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.window.registerTreeDataProvider(res.configurationManagerViewId, this.provider));

        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdConfigurationManagerRefresh, () => this.provider.refresh()));

        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdConfigurationManagerSetConfiguration, async (node?: ConfigurationManagerNode) => {
            if (node === undefined) return;
            const configurations = await ConfigurationManager.getConfigurations(node.projectPath);
            const picked = await vscode.window.showQuickPick(configurations, {
                placeHolder: `${node.projectName}: Select build configuration`
            });
            if (picked === undefined) return;

            ConfigurationManager.updateProjectState(node.projectPath, state => { state.configuration = picked; });
            this.provider.refresh();
        }));

        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdConfigurationManagerSetFramework, async (node?: ConfigurationManagerNode) => {
            if (node === undefined) return;
            const frameworks = await ConfigurationManager.getFrameworks(node.projectPath);
            if (frameworks.length === 0) {
                vscode.window.showInformationMessage(`${node.projectName} does not declare multiple target frameworks.`);
                return;
            }

            const picked = await vscode.window.showQuickPick(frameworks, {
                placeHolder: `${node.projectName}: Select target framework`
            });
            if (picked === undefined) return;

            ConfigurationManager.updateProjectState(node.projectPath, state => { state.framework = picked; });
            this.provider.refresh();
        }));

        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdConfigurationManagerToggleBuild, (node?: ConfigurationManagerNode) => {
            if (node === undefined) return;
            ConfigurationManager.updateProjectState(node.projectPath, state => { state.build = !state.build; });
            this.provider.refresh();
        }));

        context.subscriptions.push(vscode.commands.registerCommand(res.commandIdConfigurationManagerReset, (node?: ConfigurationManagerNode) => {
            if (node === undefined) return;
            const states = ConfigurationManager.getAllProjectStates();
            delete states[node.projectPath];
            StateController.putLocal(ConfigurationManager.stateKey, states);
            this.provider.refresh();
        }));

        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(`${res.extensionId}.${res.configIdRoslynProjectOrSolutionFiles}`))
                this.provider.refresh();
        }));
        context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.provider.refresh()));
    }

    public static async getConfigurations(projectPath: string): Promise<string[]> {
        const fromInterop = (await Interop.getProject(projectPath))?.configurations ?? [];
        if (fromInterop.length > 0)
            return fromInterop;

        // Parse Configuration conditions from the project file directly
        const content = await ConfigurationManager.tryReadFile(projectPath);
        if (content !== undefined) {
            const pattern = /\bConfiguration\s*==\s*['"]([^'"]+)['"]/g;
            const found = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(content)) !== null)
                found.add(m[1]);

            if (found.size > 0)
                return Array.from(found).sort();
        }

        return defaultConfigurations;
    }

    public static async getFrameworks(projectPath: string): Promise<string[]> {
        const fromInterop = (await Interop.getProject(projectPath))?.frameworks ?? [];
        if (fromInterop.length > 0)
            return fromInterop;

        const content = await ConfigurationManager.tryReadFile(projectPath);
        if (content === undefined)
            return [];

        const multi = /<TargetFrameworks[^>]*>([^<]+)<\/TargetFrameworks>/i.exec(content);
        if (multi !== null)
            return multi[1].split(';').map(f => f.trim()).filter(f => f.length > 0);

        const single = /<TargetFramework[^>]*>([^<]+)<\/TargetFramework>/i.exec(content);
        if (single !== null)
            return [single[1].trim()];

        return [];
    }

    private static async tryReadFile(filePath: string): Promise<string | undefined> {
        try { return await fs.readFile(filePath, 'utf8'); } catch { return undefined; }
    }

    public static getProjectState(projectPath: string): ProjectConfigState {
        const states = ConfigurationManager.getAllProjectStates();
        return states[projectPath] ?? { build: true };
    }

    public static getAllProjectStates(): { [projectPath: string]: ProjectConfigState } {
        return StateController.getLocal<{ [projectPath: string]: ProjectConfigState }>(ConfigurationManager.stateKey, {}) ?? {};
    }

    private static updateProjectState(projectPath: string, updater: (state: ProjectConfigState) => void): void {
        const states = ConfigurationManager.getAllProjectStates();
        const state = states[projectPath] ?? { build: true };
        updater(state);
        states[projectPath] = state;
        StateController.putLocal(ConfigurationManager.stateKey, states);
    }
}
