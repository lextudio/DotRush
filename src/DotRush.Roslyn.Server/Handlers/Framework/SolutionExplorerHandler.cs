using System.Text.Json;
using System.Text.Json.Serialization;
using DotRush.Common;
using DotRush.Common.Extensions;
using DotRush.Common.Interop;
using DotRush.Common.MSBuild;
using DotRush.Roslyn.Server.Services;
using EmmyLua.LanguageServer.Framework;
using EmmyLua.LanguageServer.Framework.Protocol.Capabilities.Client.ClientCapabilities;
using EmmyLua.LanguageServer.Framework.Protocol.Capabilities.Server;
using EmmyLua.LanguageServer.Framework.Protocol.JsonRpc;
using EmmyLua.LanguageServer.Framework.Server;
using EmmyLua.LanguageServer.Framework.Server.Handler;
using Microsoft.CodeAnalysis;
using DotRushMSBuildLocator = DotRush.Common.MSBuild.MSBuildLocator;

namespace DotRush.Roslyn.Server.Handlers.Framework;

public class SolutionExplorerHandler : IJsonHandler {
    private readonly WorkspaceService workspaceService;

    public SolutionExplorerHandler(WorkspaceService workspaceService) {
        this.workspaceService = workspaceService;
    }

    protected Task<SolutionExplorerDependencyGroup[]> Handle(SolutionExplorerProjectParams? request, CancellationToken token) {
        return SafeExtensions.InvokeAsync(Array.Empty<SolutionExplorerDependencyGroup>(), () => Task.Run(() => {
            if (string.IsNullOrEmpty(request?.ProjectPath) || !File.Exists(request.ProjectPath))
                return Array.Empty<SolutionExplorerDependencyGroup>();

            return GetDependencyGroups(request.ProjectPath);
        }, token));
    }

    public void RegisterHandler(LSPCommunicationBase lspCommunication) {
        lspCommunication.AddRequestHandler("dotrush/solutionExplorer/dependencies", async delegate (RequestMessage message, CancellationToken token) {
            var request = message.Params?.Deserialize<SolutionExplorerProjectParams>(JsonSerializerConfig.Options);
            return JsonSerializer.SerializeToDocument(await Handle(request, token).ConfigureAwait(false), JsonSerializerConfig.Options);
        });
    }

    public void RegisterCapability(ServerCapabilities serverCapabilities, ClientCapabilities clientCapabilities) {
    }

    public void RegisterDynamicCapability(LanguageServer server, ClientCapabilities clientCapabilities) {
    }

    private SolutionExplorerDependencyGroup[] GetDependencyGroups(string projectPath) {
        var project = workspaceService.Solution?.Projects.FirstOrDefault(project => PathExtensions.Equals(project.FilePath, projectPath));
        var evaluatedItems = GetEvaluatedItems(projectPath);
        var versionByPackage = evaluatedItems.GetItems("PackageVersion")
            .Where(item => !string.IsNullOrEmpty(item.Identity) && item.Metadata.TryGetValue("Version", out var version) && !string.IsNullOrEmpty(version))
            .GroupBy(item => item.Identity)
            .ToDictionary(group => group.Key, group => group.First().Metadata["Version"]);

        var groups = new List<SolutionExplorerDependencyGroup>();
        var projectReferences = GetProjectReferences(project, evaluatedItems, projectPath);
        if (projectReferences.Count != 0)
            groups.Add(new SolutionExplorerDependencyGroup("Projects", projectReferences));

        var packages = evaluatedItems.GetItems("PackageReference")
            .Where(item => !string.IsNullOrEmpty(item.Identity))
            .Select(item => new SolutionExplorerDependencyItem {
                Name = item.Identity,
                Version = item.Metadata.GetValueOrDefault("Version") ?? versionByPackage.GetValueOrDefault(item.Identity),
                FilePath = item.Metadata.GetValueOrDefault("DefiningProjectFullPath"),
                Line = FindItemLine(item.Metadata.GetValueOrDefault("DefiningProjectFullPath"), "PackageReference", item.Identity)
            })
            .DistinctBy(item => item.Name)
            .OrderBy(item => item.Name)
            .ToArray();
        if (packages.Length != 0)
            groups.Add(new SolutionExplorerDependencyGroup("Packages", packages));

        var frameworks = GetFrameworkReferences(evaluatedItems);
        if (frameworks.Length != 0)
            groups.Add(new SolutionExplorerDependencyGroup("Frameworks", frameworks));

        var analyzers = evaluatedItems.GetItems("Analyzer")
            .Where(item => !string.IsNullOrEmpty(item.Identity))
            .Select(item => new SolutionExplorerDependencyItem {
                Name = Path.GetFileName(item.Identity),
                FilePath = item.Metadata.GetValueOrDefault("DefiningProjectFullPath") ?? item.Metadata.GetValueOrDefault("FullPath"),
                Line = FindItemLine(item.Metadata.GetValueOrDefault("DefiningProjectFullPath"), "Analyzer", item.Identity)
            })
            .OrderBy(item => item.Name)
            .ToArray();
        if (analyzers.Length != 0)
            groups.Add(new SolutionExplorerDependencyGroup("Analyzers", analyzers));

        return groups.ToArray();
    }

    private static List<SolutionExplorerDependencyItem> GetProjectReferences(Project? project, EvaluatedItems evaluatedItems, string projectPath) {
        var references = new List<SolutionExplorerDependencyItem>();
        if (project != null) {
            foreach (var reference in project.ProjectReferences) {
                var referencedProject = project.Solution.GetProject(reference.ProjectId);
                if (referencedProject?.FilePath == null)
                    continue;

                references.Add(new SolutionExplorerDependencyItem {
                    Name = referencedProject.Name,
                    FilePath = projectPath,
                    TargetPath = referencedProject.FilePath,
                    Line = FindItemLine(projectPath, "ProjectReference", referencedProject.FilePath)
                });
            }
        }

        foreach (var item in evaluatedItems.GetItems("ProjectReference")) {
            if (string.IsNullOrEmpty(item.Identity))
                continue;

            var fullPath = item.Metadata.GetValueOrDefault("FullPath") ?? Path.GetFullPath(Path.Combine(Path.GetDirectoryName(projectPath)!, item.Identity));
            if (references.Any(reference => PathExtensions.Equals(reference.TargetPath, fullPath)))
                continue;

            references.Add(new SolutionExplorerDependencyItem {
                Name = Path.GetFileNameWithoutExtension(fullPath),
                FilePath = item.Metadata.GetValueOrDefault("DefiningProjectFullPath") ?? projectPath,
                TargetPath = fullPath,
                Line = FindItemLine(item.Metadata.GetValueOrDefault("DefiningProjectFullPath") ?? projectPath, "ProjectReference", item.Identity)
            });
        }

        return references.OrderBy(reference => reference.Name).ToList();
    }

    private static SolutionExplorerDependencyItem[] GetFrameworkReferences(EvaluatedItems evaluatedItems) {
        var targetFrameworks = evaluatedItems.GetProperty("TargetFrameworks")
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(framework => new SolutionExplorerDependencyItem { Name = framework });
        var frameworkReferences = evaluatedItems.GetItems("FrameworkReference")
            .Where(item => !string.IsNullOrEmpty(item.Identity))
            .Select(item => new SolutionExplorerDependencyItem {
                Name = item.Identity,
                FilePath = item.Metadata.GetValueOrDefault("DefiningProjectFullPath"),
                Line = FindItemLine(item.Metadata.GetValueOrDefault("DefiningProjectFullPath"), "FrameworkReference", item.Identity)
            });

        return targetFrameworks.Concat(frameworkReferences)
            .DistinctBy(item => item.Name)
            .OrderBy(item => item.Name)
            .ToArray();
    }

    private static EvaluatedItems GetEvaluatedItems(string projectPath) {
        var result = new ProcessRunner(DotRushMSBuildLocator.DotNetTool, new ProcessArgumentBuilder()
            .Append("msbuild")
            .AppendQuoted(projectPath)
            .Append("-getProperty:TargetFrameworks")
            .Append("-getItem:ProjectReference")
            .Append("-getItem:PackageReference")
            .Append("-getItem:PackageVersion")
            .Append("-getItem:FrameworkReference")
            .Append("-getItem:Analyzer"))
            .WaitForExit();

        if (!result.Success)
            return EvaluatedItems.Empty;

        return EvaluatedItems.Parse(result.GetOutput());
    }

    private static int? FindItemLine(string? filePath, string itemName, string? identity) {
        if (string.IsNullOrEmpty(filePath) || string.IsNullOrEmpty(identity) || !File.Exists(filePath))
            return null;

        var lines = File.ReadAllLines(filePath);
        for (var i = 0; i < lines.Length; i++) {
            var line = lines[i];
            if (!line.Contains($"<{itemName}", StringComparison.OrdinalIgnoreCase))
                continue;

            if (line.Contains(identity, StringComparison.OrdinalIgnoreCase)
                || line.Contains(Path.GetFileName(identity), StringComparison.OrdinalIgnoreCase))
                return i;
        }

        return null;
    }
}

public class SolutionExplorerProjectParams {
    [JsonPropertyName("projectPath")] public string? ProjectPath { get; set; }
}

public class SolutionExplorerDependencyGroup {
    [JsonPropertyName("name")] public string Name { get; set; }
    [JsonPropertyName("items")] public ICollection<SolutionExplorerDependencyItem> Items { get; set; }

    public SolutionExplorerDependencyGroup(string name, ICollection<SolutionExplorerDependencyItem> items) {
        Name = name;
        Items = items;
    }
}

public class SolutionExplorerDependencyItem {
    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    [JsonPropertyName("version")] public string? Version { get; set; }
    [JsonPropertyName("filePath")] public string? FilePath { get; set; }
    [JsonPropertyName("targetPath")] public string? TargetPath { get; set; }
    [JsonPropertyName("line")] public int? Line { get; set; }
}

internal class EvaluatedItems {
    public static EvaluatedItems Empty { get; } = new();

    private Dictionary<string, string> Properties { get; init; } = new();
    private Dictionary<string, List<EvaluatedItem>> Items { get; init; } = new();

    public string GetProperty(string name) {
        return Properties.GetValueOrDefault(name) ?? string.Empty;
    }

    public IEnumerable<EvaluatedItem> GetItems(string name) {
        return Items.GetValueOrDefault(name) ?? Enumerable.Empty<EvaluatedItem>();
    }

    public static EvaluatedItems Parse(string json) {
        using var document = JsonDocument.Parse(json);
        var result = new EvaluatedItems();

        if (document.RootElement.TryGetProperty("Properties", out var properties)) {
            foreach (var property in properties.EnumerateObject())
                result.Properties[property.Name] = property.Value.GetString() ?? string.Empty;
        }

        if (!document.RootElement.TryGetProperty("Items", out var items))
            return result;

        foreach (var itemGroup in items.EnumerateObject()) {
            var values = new List<EvaluatedItem>();
            foreach (var item in itemGroup.Value.EnumerateArray()) {
                var evaluatedItem = new EvaluatedItem {
                    Identity = item.TryGetProperty("Identity", out var identity) ? identity.GetString() ?? string.Empty : string.Empty
                };

                foreach (var metadata in item.EnumerateObject()) {
                    if (metadata.NameEquals("Identity"))
                        continue;

                    evaluatedItem.Metadata[metadata.Name] = metadata.Value.GetString() ?? string.Empty;
                }

                values.Add(evaluatedItem);
            }

            result.Items[itemGroup.Name] = values;
        }

        return result;
    }
}

internal class EvaluatedItem {
    public string Identity { get; init; } = string.Empty;
    public Dictionary<string, string> Metadata { get; } = new();
}
