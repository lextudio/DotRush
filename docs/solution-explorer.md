# DotRush Solution Explorer Design

## Source Model

This design mirrors the Visual Studio Solution Explorer workflow documented by Microsoft Learn: <https://learn.microsoft.com/en-us/visualstudio/ide/use-solution-explorer?view=visualstudio>. That page describes Solution Explorer as the main tool window for managing solutions, projects, files, dependencies, and common project actions. It also breaks down the UI into toolbar, search bar, main tree, solution nodes, project nodes, dependencies, program/source nodes, Git integration, and context menus.

DotRush should not keep asking users to choose workspace targets from a startup popup. The correct model is a persistent Solution Explorer that makes the active solution/project visible, navigable, searchable, and actionable.

## Reference Screenshots

Use the Microsoft screenshots as visual and interaction references. Do not copy bitmap assets into DotRush; use them as implementation references only.

| Reference | What to mirror in DotRush | Screenshot |
| --- | --- | --- |
| IDE placement | Solution Explorer is a docked side-bar tool window, not a modal picker. DotRush should place the view in VS Code's Explorer container. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/visual-studio-integrated-development-environment.png> |
| Annotated Solution Explorer | Tree anatomy: toolbar, search bar, main tree, solution node, project node, dependencies node, program/source node, Git tab adjacency. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/solution-explorer-tool-window-lrg.png> |
| Toolbar | Back, Forward, Home, Switch Views, pending changes filter, sync active document, refresh, collapse all, show all files, properties, preview selected items. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/solution-explorer-toolbar.png> |
| Search | Search box with scoped options for file names, file contents, and external items. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/vs-2022/use-solution-explorer/solution-explorer-search-bar.png> |
| Solution context menu | Solution-level commands such as build, rebuild, clean, restore, add, project dependencies, build order, startup project configuration, Git actions, properties. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/solution-node-context-menu-lrg.png> |
| Project context menu | Project-level commands such as build, rebuild, clean, publish, add, manage packages, set as startup project, dependencies, Git actions, properties. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/project-node-context-menu-lrg.png> |
| Add flyout | Node-specific Add commands for projects, new items, existing items, folders, and dependencies. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/solution-explorer-context-menu-add-flyout.png> |
| Quick Add | Fast creation of files, folders, nested paths, and simple classes from the project/folder context. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/visualstudio/quick-add-new-item.png> |
| Compare | File comparison from Solution Explorer without leaving the IDE. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/vs-2022/file-comparison.png> |
| Collapse descendants | Recursive collapse command for deep trees. | <https://learn.microsoft.com/en-us/visualstudio/ide/media/vs-2022/solution-explorer-collapse-descendants.png> |

## Product Goals

- Replace automatic startup Quick Pick target selection with a persistent `DotRush: Solution Explorer`.
- Make opening solutions, projects, folders, and files the primary Phase 1 workflow.
- Make the loaded Roslyn workspace target visible and changeable from an explicit tree command.
- Represent the solution/project/file hierarchy rather than a flat list of candidate files.
- Match Visual Studio's mental model while staying inside native VS Code extension APIs.
- Use `dotrush.roslyn.projectOrSolutionFiles` as the source of truth for loaded targets so existing Roslyn server behavior remains compatible.
- Defer Visual Studio parity features that are not required for browsing and opening code.

## User Experience

The view appears in DotRush's C# Activity Bar container as `Solution Explorer`. It is persistent, refreshable, and available whenever a workspace is open.

The first glance should be intentionally quiet. If no solution is open, the tree is empty and the toolbar leads with `Open Solution`. DotRush should not auto-populate the tree with every folder item in the VS Code workspace.

The first screen should show a solution-first hierarchy:

```text
Solution 'DotRush' (12 projects)
  Solution Items
  src
    DotRush.Common
      Dependencies
      Properties
      src files...
    DotRush.Roslyn.Server
      Dependencies
      Properties
      src files...
  tests
    DotRush.Roslyn.Server.Tests
Projects
  LooseProject
```

After the user opens a `.sln` or `.slnx`, the tree shows that solution as the root and lists its projects. When a solution or project is the active Roslyn target, show a clear check decoration and `active` description. The active state must be derived from `dotrush.roslyn.projectOrSolutionFiles`.

Opening is the default action for solution, project, and file nodes. Commands that change DotRush workspace state must remain explicit context-menu or toolbar actions so ordinary navigation does not reload the language server.

## Visual Studio Feature Mapping

| Visual Studio element | DotRush behavior |
| --- | --- |
| Tool window | Native VS Code tree view in the Explorer container. |
| Toolbar Back/Forward | Phase 2: navigate search/filter result history. |
| Toolbar Home | Return from search/folder/scoped view to the solution root. |
| Switch Views | Phase 2: toggle Solution View and Folder View. |
| Pending Changes filter | Phase 3: use VS Code SCM API to show changed/open files. |
| Sync with Active Document | Phase 2: reveal the active editor file in Solution Explorer. |
| Refresh | Phase 1: rescan solutions/projects and refresh tree. |
| Collapse All | Phase 1 if feasible with VS Code command APIs; otherwise Phase 2. |
| Show All Files | Phase 2: show physical files that are not included by project items. |
| File Nesting | Phase 3: group related files such as `.xaml/.xaml.cs`, `.razor/.razor.cs`, generated files, and designer files. |
| Properties | Phase 2: open project/file properties using VS Code commands or a DotRush properties view. |
| Preview Selected Items | Map to VS Code preview editor behavior; no custom implementation unless needed. |
| Search bar | Phase 2: tree-local search with filters for name, content, external/dependency items. |
| Solution node | Root of `.sln`, `.slnx`, or `.slnf`, with build, restore, clean, reload, add, dependencies, startup configuration, and properties. |
| Project node | Child of solution or loose project group, with build, restore, clean, set startup, add, dependencies, package management, and properties. |
| Dependencies node | Phase 2: project references, package references, framework references, analyzers, SDKs. |
| Program/source node | Phase 2: source files and folders from project items. |
| Git tab/menu | Use VS Code SCM for decorations first; context menu commands can call built-in Git commands later. |
| Add menu | Phase 2: add project, new item, existing item, new folder, reference/package. |
| Quick Add | Phase 2: fast project/folder file creation with nested path support. |
| File compare | Phase 3: integrate with VS Code compare commands for selected files. |
| Collapse All Descendants | Phase 2: recursive collapse for selected tree branch. |
| New Solution Explorer View | Phase 3: scoped view rooted at a selected folder/project. |

## Tree Model

### Node Types

- Workspace root: virtual root when multiple workspace folders exist.
- Solution: `.sln`, `.slnx`, or `.slnf`.
- Solution folder: logical solution folder from solution metadata.
- Solution item: non-project file listed at solution level.
- Project: `.csproj`, `.fsproj`, `.vbproj`.
- Project folder: physical or project-defined folder.
- Source file: compile/content/none items, with nesting where appropriate.
- Dependencies: project references, package references, framework references, analyzers, SDKs.
- Properties: launch settings, project properties, configurations, target frameworks.
- Loose Projects: grouping for projects not contained by any discovered solution.
- External Items: generated files, metadata-as-source, or files outside workspace when enabled.

### Identity

Every node must have a stable ID:

```text
solution:<absolute solution path>
project:<absolute project path>
file:<absolute file path>
dependency:<project path>:<dependency kind>:<dependency id>
solution-folder:<solution path>:<solution folder guid>
```

Stable IDs are required for expansion state, reveal, refresh, and future drag/drop.

### Active Target Rules

- If `dotrush.roslyn.projectOrSolutionFiles` contains a solution path, that solution is active.
- If it contains a project path, that project is active.
- If it contains multiple paths, all matching nodes are active and the root shows a multi-target state.
- If the setting is empty, DotRush should default to the best solution when there is exactly one solution, otherwise show all discovered roots and prompt through the view welcome/empty state rather than a modal picker.

## Toolbar Design

Phase 1 toolbar:

- Open Solution: first toolbar item; opens a `.sln` or `.slnx`, stores it as the workspace target, and reloads DotRush.
- Refresh: rescan filesystem and solution/project membership.
- Set Active Target: enabled when a solution/project node is selected.

Future toolbar:

- Home: reset search/filter/scope.
- Sync with Active Document: reveal active editor file.
- Switch View: Solution View vs Folder View.
- Search: focus Solution Explorer search.
- Show All Files toggle.
- File Nesting toggle.
- Back/Forward through search/reveal history.
- Pending Changes/Open Files filter.
- Properties.
- Preview Selected Items toggle if VS Code behavior is insufficient.

## Search Design

Visual Studio exposes search with options for file contents and external items. DotRush should implement:

- Name search: filters visible nodes by label/path.
- Content search: delegates to VS Code workspace search or `rg` for file contents.
- External item search: includes dependencies, generated files, and metadata nodes when those are loaded.
- Search history: Back and Forward toolbar buttons navigate result sets.
- Home clears search and returns to the default solution view.

Search can wait for a future release. The initial tree should be structured so filtering can be added later without changing node identity.

## Context Menus

### Solution Node

Phase 1 commands:

- Set as Workspace Target
- Open Solution File
- Build
- Restore
- Clean

Future commands:

- Reload DotRush Workspace
- Add > New Project
- Add > Existing Project
- Add > New Solution Folder
- Project Dependencies
- Project Build Order
- Set Startup Projects
- Open in Integrated Terminal
- Reveal in Finder/Explorer
- Copy Path
- Properties

### Project Node

Phase 1 commands:

- Open Project File
- Set as Startup Project
- Set as Workspace Target
- Build
- Restore
- Clean

Future commands:

- Run Tests if test project
- Debug Tests if test project
- Add > New Item
- Add > Existing Item
- Add > New Folder
- Add > Project Reference
- Manage NuGet Packages
- Dependencies > Add Reference / Add Package
- Open in Integrated Terminal
- Reveal in Finder/Explorer
- Copy Path
- Properties

### Folder Node

Phase 1 commands:

- Open files and expand folders

Future commands:

- Add > New Item
- Add > Existing Item
- Add > New Folder
- Quick Add
- Compare Selected when two files are selected
- Open in Integrated Terminal
- Reveal in Finder/Explorer
- Copy Path

### File Node

Phase 1 commands:

- Open

Future commands:

- Open With
- Rename
- Delete
- Copy
- Compare With
- Compare Selected when exactly two files are selected
- Exclude From Project
- Properties

## Quick Add

Quick Add can wait for a future release. When implemented, it should be optimized for common C# work:

- `Customer.cs` creates a file in the selected project/folder.
- `Features/Auth/LoginHandler.cs` creates nested folders and file.
- `Models/Order.cs, Models/OrderLine.cs` creates multiple files.
- `README`, `.editorconfig`, `Directory.Build.props` are accepted without template ceremony.
- For `.cs` files, optional class scaffolding should match namespace and project style.
- A secondary action opens the existing template-based project/item flow.

## Loading and Parsing

Phase 1:

- Discover `.sln`, `.slnf`, `.slnx`, `.csproj`, `.fsproj`, `.vbproj`.
- Parse classic `.sln` `Project(...)` records.
- Show `.slnf` and `.slnx` as solution roots even if deep parsing is deferred.
- Show loose projects under `Projects`.

Phase 2:

- Parse `.slnx` structurally.
- Parse `.slnf` solution filters and map included projects back to the base solution.
- Parse SDK-style project items using MSBuild evaluation from the existing DotRush/Roslyn infrastructure where possible.
- Include dependencies and target frameworks.

Phase 3:

- Incremental refresh from file watchers.
- Source-generated files and analyzer-provided virtual documents.
- Persist expansion and filters across sessions.

## Integration With Existing DotRush

The existing setting remains authoritative:

```json
"dotrush.roslyn.projectOrSolutionFiles": [
  "/absolute/path/to/MySolution.sln"
]
```

The Solution Explorer writes this setting when the user sets a workspace target, then calls `dotrush.reloadWorkspace`.

Existing commands should be reused:

- `dotrush.build`
- `dotrush.restore`
- `dotrush.clean`
- `dotrush.setStartupProject`
- `dotrush.reloadWorkspace`
- `dotrush.createNewProject`

The old `dotrush.pickProjectOrSolutionFiles` command can remain as a compatibility fallback, but activation must not call it automatically.

## Phased Implementation

### Phase 1: Remove Popup and Add Native Browsing Tree

- Add `DotRush: Solution Explorer` tree view.
- Keep the initial tree empty until a user opens a solution.
- Add Open Solution as the first toolbar command.
- Discover projects from the selected solution.
- Parse classic `.sln` project membership and `.slnx` `<Project Path="...">` entries.
- Show project folders and files using a native tree.
- Show `Dependencies` and `Properties` as first-level project nodes to follow Visual Studio's project shape.
- Populate initial `Dependencies` from `ProjectReference`, `PackageReference`, and `Analyzer` items in the project file.
- Show package versions in the right-hand description column.
- Keep a light TypeScript parser for the immediate tree skeleton and fallback display.
- Use the language server for evaluated dependency data. Accurate framework/dependency resolution must come from evaluated MSBuild data because properties, imports, conditions, and multi-targeting expressions can change the final values.
- Hide `.csproj`, `.fsproj`, and `.vbproj` files from project contents because projects are already represented as top-level nodes.
- Add project context menu commands for Build, Rebuild, and Clean.
- Open solution files, project files, and source files from the tree.
- Show active target decoration.
- Add Refresh and explicit Set as Workspace Target.
- Remove automatic startup Quick Pick.

### Future Releases

- Replace filesystem folder expansion with MSBuild-evaluated project items.
- Add Dependencies and Properties nodes.
- Add Add menu, Quick Add, Set Startup Project, terminal, reveal, copy path.
- Add Sync with Active Document.
- Add tree-local search.
- Add Show All Files and File Nesting toggles.
- Add pending changes/open files filter.
- Add Back/Forward/Home search history.
- Add file compare workflows.
- Add Collapse All Descendants.
- Add New Solution Explorer View scoped roots.
- Add solution folder editing and project add/remove.
- Add project dependency/build order UI.

## Acceptance Criteria

- Opening a workspace with multiple solutions/projects never triggers a startup Quick Pick and never dumps the whole workspace folder into the tree.
- With no selected solution, the Solution Explorer tree is empty and the first toolbar action is Open Solution.
- After opening a solution, the Solution Explorer shows that solution, its projects, project folders, and files.
- Users can open solution files, project files, and source files from the tree.
- Active target state is visible without opening settings.
- Setting a solution/project as workspace target updates `dotrush.roslyn.projectOrSolutionFiles` and reloads DotRush.
- Existing build, restore, clean, debug, and test behavior continues to work.
- The design remains explicitly traceable to the Visual Studio Solution Explorer UI described by Microsoft Learn.
