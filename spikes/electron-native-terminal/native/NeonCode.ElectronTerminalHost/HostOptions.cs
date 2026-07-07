namespace NeonCode.ElectronTerminalHost;

public sealed class HostOptions
{
    public nint ParentHwnd { get; set; }
    public int TopOffset { get; set; } = 52;
    public string Endpoint { get; set; } = "ws://127.0.0.1:44777/ws";
    public string Command { get; set; } = "bash";

    public static HostOptions Parse(string[] args)
    {
        var options = new HostOptions();

        foreach (var arg in args)
        {
            if (TryReadValue(arg, "--parent-hwnd", out var parentHwnd) && long.TryParse(parentHwnd, out var hwndValue))
            {
                options.ParentHwnd = (nint)hwndValue;
            }
            else if (TryReadValue(arg, "--top-offset", out var topOffset) && int.TryParse(topOffset, out var topOffsetValue))
            {
                options.TopOffset = Math.Max(0, topOffsetValue);
            }
            else if (TryReadValue(arg, "--endpoint", out var endpoint) && !string.IsNullOrWhiteSpace(endpoint))
            {
                options.Endpoint = endpoint;
            }
            else if (TryReadValue(arg, "--command", out var command) && !string.IsNullOrWhiteSpace(command))
            {
                options.Command = command;
            }
        }

        return options;
    }

    private static bool TryReadValue(string arg, string name, out string value)
    {
        var prefix = name + "=";
        if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            value = arg[prefix.Length..];
            return true;
        }

        value = string.Empty;
        return false;
    }
}
