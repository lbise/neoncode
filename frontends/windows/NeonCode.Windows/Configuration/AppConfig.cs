using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace NeonCode.Windows.Configuration;

public sealed class AppConfig
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    public TerminalConfig Terminal { get; set; } = new();

    public static string ConfigDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "NeonCode");

    public static string ConfigPath => Path.Combine(ConfigDirectory, "config.json");

    private static string LegacyConfigDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "WorkspaceCockpit");

    private static string LegacyConfigPath => Path.Combine(LegacyConfigDirectory, "config.json");

    public static AppConfig LoadOrCreateDefault()
    {
        Directory.CreateDirectory(ConfigDirectory);

        if (!File.Exists(ConfigPath))
        {
            if (File.Exists(LegacyConfigPath))
            {
                File.Copy(LegacyConfigPath, ConfigPath, overwrite: false);
            }
            else
            {
                var defaultConfig = new AppConfig();
                defaultConfig.Save();
                return defaultConfig;
            }
        }

        try
        {
            var json = File.ReadAllText(ConfigPath);
            var config = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions) ?? new AppConfig();
            config.ApplyDefaults();
            return config;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            var invalidPath = Path.Combine(
                ConfigDirectory,
                $"config.invalid.{DateTimeOffset.Now:yyyyMMddHHmmss}.json");

            try
            {
                File.Copy(ConfigPath, invalidPath, overwrite: false);
            }
            catch
            {
                // Best-effort backup only. The app should still start with defaults.
            }

            var defaultConfig = new AppConfig();
            defaultConfig.Save();
            return defaultConfig;
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(ConfigDirectory);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, JsonOptions));
    }

    private void ApplyDefaults()
    {
        Terminal ??= new TerminalConfig();
        Terminal.ApplyDefaults();
    }
}

public sealed class TerminalConfig
{
    public string FontFace { get; set; } = "Cascadia Mono";
    public double FontSize { get; set; } = 14;
    public string Background { get; set; } = "#0C0C0C";
    public string Foreground { get; set; } = "#CCCCCC";
    public string SelectionBackground { get; set; } = "#666666";
    public string CursorStyle { get; set; } = "BlinkingBlock";
    public string[] ColorTable { get; set; } =
    [
        "#0C0C0C",
        "#C50F1F",
        "#13A10E",
        "#C19C00",
        "#0037DA",
        "#881798",
        "#3A96DD",
        "#CCCCCC",
        "#767676",
        "#E74856",
        "#16C60C",
        "#F9F1A5",
        "#3B78FF",
        "#B4009E",
        "#61D6D6",
        "#F2F2F2",
    ];

    public void ApplyDefaults()
    {
        if (string.IsNullOrWhiteSpace(FontFace))
        {
            FontFace = "Cascadia Mono";
        }

        if (FontSize <= 0)
        {
            FontSize = 14;
        }

        if (string.IsNullOrWhiteSpace(Background))
        {
            Background = "#0C0C0C";
        }

        if (string.IsNullOrWhiteSpace(Foreground))
        {
            Foreground = "#CCCCCC";
        }

        if (string.IsNullOrWhiteSpace(SelectionBackground))
        {
            SelectionBackground = "#666666";
        }

        if (string.IsNullOrWhiteSpace(CursorStyle))
        {
            CursorStyle = "BlinkingBlock";
        }

        if (ColorTable is not { Length: 16 })
        {
            ColorTable = new TerminalConfig().ColorTable;
        }
    }
}
