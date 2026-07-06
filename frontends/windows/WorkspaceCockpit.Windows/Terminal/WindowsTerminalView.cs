using System.Text;
using System.Windows;
using System.Windows.Media;
using Microsoft.Terminal.Wpf;
using WorkspaceCockpit.Windows.Configuration;
using WpfTerminalControl = Microsoft.Terminal.Wpf.TerminalControl;

namespace WorkspaceCockpit.Windows.Terminal;

public sealed class WindowsTerminalView : ITerminalView
{
    private readonly WpfTerminalControl control;
    private readonly BridgeConnection connection;
    private readonly TerminalConfig config;
    private readonly FontResolution fontResolution;

    public WindowsTerminalView(TerminalConfig config)
    {
        this.config = config;
        fontResolution = ResolveFontFace(config.FontFace);
        connection = new BridgeConnection(this);
        control = new WpfTerminalControl
        {
            AutoResize = true,
            Connection = connection,
            Focusable = true,
        };

        control.Loaded += (_, _) => ApplyTheme();
    }

    public event Action<byte[]>? Input;
    public event Action<uint, uint>? Resized;

    public FrameworkElement Element => control;

    public string EffectiveFontFace => fontResolution.EffectiveFontFace;

    public bool IsUsingFontFallback => fontResolution.IsFallback;

    public void Write(byte[] data)
    {
        var text = Encoding.UTF8.GetString(data);
        control.Dispatcher.Invoke(() => connection.RaiseOutput(text));
    }

    public void Resize(uint columns, uint rows)
    {
        _ = control.ResizeAsync(rows, columns, CancellationToken.None);
    }

    public void Clear()
    {
        control.Dispatcher.Invoke(() => connection.RaiseOutput("\x1bc"));
    }

    private void OnInput(string data)
    {
        Input?.Invoke(Encoding.UTF8.GetBytes(data));
    }

    private void OnResize(uint rows, uint columns)
    {
        Resized?.Invoke(columns, rows);
    }

    private void ApplyTheme()
    {
        var background = ParseColor(config.Background, Color.FromRgb(0x0C, 0x0C, 0x0C));
        var foreground = ParseColor(config.Foreground, Color.FromRgb(0xCC, 0xCC, 0xCC));
        var selectionBackground = ParseColor(config.SelectionBackground, Color.FromRgb(0x66, 0x66, 0x66));
        var colorTable = config.ColorTable
            .Take(16)
            .Select(color => ToColorRef(ParseColor(color, Colors.Black)))
            .ToArray();

        if (colorTable.Length != 16)
        {
            colorTable = new TerminalConfig().ColorTable
                .Select(color => ToColorRef(ParseColor(color, Colors.Black)))
                .ToArray();
        }

        control.SetTheme(
            new TerminalTheme
            {
                DefaultBackground = ToColorRef(background),
                DefaultForeground = ToColorRef(foreground),
                DefaultSelectionBackground = ToColorRef(selectionBackground),
                CursorStyle = ParseCursorStyle(config.CursorStyle),
                ColorTable = colorTable,
            },
            fontResolution.EffectiveFontFace,
            ToNativeFontSize(config.FontSize),
            background);
    }

    private static short ToNativeFontSize(double configuredFontSize)
    {
        return (short)Math.Clamp((int)Math.Round(configuredFontSize), 1, 200);
    }

    private static FontResolution ResolveFontFace(string configuredFontFace)
    {
        var requestedFontFace = string.IsNullOrWhiteSpace(configuredFontFace)
            ? "Cascadia Mono"
            : configuredFontFace.Trim();

        var installedFontNames = Fonts.SystemFontFamilies.Select(font => font.Source).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (installedFontNames.Contains(requestedFontFace))
        {
            return new FontResolution(requestedFontFace, IsFallback: false);
        }

        var fallback = installedFontNames.Contains("Cascadia Mono") ? "Cascadia Mono" : "Consolas";
        return new FontResolution(fallback, IsFallback: true);
    }

    private static CursorStyle ParseCursorStyle(string value)
    {
        return Enum.TryParse<CursorStyle>(value, ignoreCase: true, out var cursorStyle)
            ? cursorStyle
            : CursorStyle.BlinkingBlock;
    }

    private static Color ParseColor(string value, Color fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        var hex = value.Trim();
        if (hex.StartsWith('#'))
        {
            hex = hex[1..];
        }

        if (hex.Length != 6 || !int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var rgb))
        {
            return fallback;
        }

        return Color.FromRgb(
            (byte)((rgb >> 16) & 0xFF),
            (byte)((rgb >> 8) & 0xFF),
            (byte)(rgb & 0xFF));
    }

    private static uint ToColorRef(Color color)
    {
        // Win32 COLORREF is 0x00BBGGRR.
        return (uint)(color.R | (color.G << 8) | (color.B << 16));
    }

    private sealed record FontResolution(string EffectiveFontFace, bool IsFallback);

    private sealed class BridgeConnection : Microsoft.Terminal.Wpf.ITerminalConnection
    {
        private readonly WindowsTerminalView owner;

        public BridgeConnection(WindowsTerminalView owner)
        {
            this.owner = owner;
        }

        public event EventHandler<TerminalOutputEventArgs>? TerminalOutput;

        public void Start()
        {
            // The Rust hub session is started by the app once the WebSocket is connected.
        }

        public void WriteInput(string data)
        {
            owner.OnInput(data);
        }

        public void Resize(uint rows, uint columns)
        {
            owner.OnResize(rows, columns);
        }

        public void Close()
        {
        }

        public void RaiseOutput(string data)
        {
            TerminalOutput?.Invoke(this, new TerminalOutputEventArgs(data));
        }
    }
}
