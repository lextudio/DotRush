# Configuration Manager

## Overview

The Configuration Manager is a panel in the DotRush activity bar that allows developers to control build configurations and target frameworks on a per-project basis within the active solution. It mirrors the Configuration Manager dialog in Visual Studio (`Build > Configuration Manager`).

In Visual Studio, the Configuration Manager lets you:
- View all projects in a solution
- Set each project's active build configuration (Debug, Release, custom)
- Set each project's target platform (AnyCPU, x64, x86)
- Toggle whether a project is included in the solution build

In DotRush for VS Code, the Configuration Manager adapts this to the VS Code paradigm:
- A tree view lists every project in the active solution
- Each project node shows its active configuration and target framework as its description
- Context-menu commands let the user change configuration, change target framework, or toggle the build flag
- Settings are persisted per-workspace in VS Code's workspace state

## Architecture

### Tree view

View ID: `dotrush.configurationManager`  
Container: DotRush activity bar (same as Solution Explorer)

The tree has one level: one node per project in the active solution. The node label is the project name and the description is `<Configuration> | <Framework>` (or just `<Configuration>` for single-targeted projects). An eye-slash icon indicates a project that has been excluded from the build.

### Per-project state

Per-project settings are stored in VS Code workspace state under a single key `configManager.projects`, as a JSON object mapping absolute project paths to a record:

```ts
interface ProjectConfigState {
    configuration?: string;  // undefined → inherit from StatusBar global
    framework?: string;      // undefined → inherit from StatusBar global
    build: boolean;          // default true
}
```

When a value is `undefined` the feature falls back to `StatusBarController.activeConfiguration` / `activeFramework` so existing behavior is preserved for projects that have never been explicitly configured.

### Integration with build tasks

`DotNetTaskProvider.getBuildTask`, `getRebuildTask`, and `getCleanTask` already accept a project path. They will now look up per-project overrides from `ConfigurationManager.getProjectState()` and apply them when constructing the `dotnet build` command line, giving each project its own `-p:Configuration=` and `-p:TargetFramework=` flags.

Projects with `build: false` are skipped when Solution Explorer triggers a workspace-level build, but can still be built individually from Solution Explorer.

### Commands

| Command ID | Title | Description |
|---|---|---|
| `dotrush.configurationManager.refresh` | Refresh | Re-read solution and redraw the tree |
| `dotrush.configurationManager.setProjectConfiguration` | Set Configuration | QuickPick of configurations declared in the project |
| `dotrush.configurationManager.setProjectFramework` | Set Target Framework | QuickPick of frameworks declared in the project |
| `dotrush.configurationManager.toggleProjectBuild` | Toggle Build | Include/exclude the project from workspace builds |
| `dotrush.configurationManager.resetProject` | Reset to Default | Clear per-project overrides and inherit from the global setting |

### UX flow

1. User opens the **DotRush** activity bar. Both **Solution Explorer** and **Configuration Manager** panels are visible.
2. Configuration Manager shows a flat list of projects. Each row displays `ProjectName` with description `Debug | net9.0`.
3. Right-clicking a project offers the five commands above.
4. **Set Configuration** opens a QuickPick populated by calling `Interop.getProject(projectPath)` to read the configurations array. The chosen value is persisted and the row description updates immediately.
5. **Set Target Framework** works identically for the frameworks array.
6. **Toggle Build** flips the `build` flag. The node icon switches to `eye-closed` when `build = false`.
7. Any build triggered from Solution Explorer (Build Project, Rebuild Project, Clean Project) respects these settings.

## Limitations

- Platform (AnyCPU / x64 / x86) is not directly surfaced; it is subsumed by the target framework selection, which is how the .NET CLI handles it.
- Creating or editing named solution configurations (like VS's "New…" button in Configuration Manager) is out of scope. DotRush reads configurations declared in each `.csproj` file.
- Changes are local to the VS Code workspace state and are not written back to the `.sln` file.
