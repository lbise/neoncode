using System.Text;
using System.Windows;
using System.Windows.Media;
using Microsoft.Terminal.Wpf;
using WpfTerminalControl = Microsoft.Terminal.Wpf.TerminalControl;

namespace WorkspaceCockpit.Windows.Terminal;

public sealed class WindowsTerminalView : ITerminalView
{
    private readonly WpfTerminalControl control;
    private readonly BridgeConnection connection;

    public WindowsTerminalView()
    {
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
        control.SetTheme(
            new TerminalTheme
            {
                DefaultBackground = ColorRef(0x0C, 0x0C, 0x0C),
                DefaultForeground = ColorRef(0xCC, 0xCC, 0xCC),
                DefaultSelectionBackground = ColorRef(0x66, 0x66, 0x66),
                CursorStyle = CursorStyle.BlinkingBlock,
                ColorTable =
                [
                    ColorRef(0x0C, 0x0C, 0x0C),
                    ColorRef(0xC5, 0x0F, 0x1F),
                    ColorRef(0x13, 0xA1, 0x0E),
                    ColorRef(0xC1, 0x9C, 0x00),
                    ColorRef(0x00, 0x37, 0xDA),
                    ColorRef(0x88, 0x17, 0x98),
                    ColorRef(0x3A, 0x96, 0xDD),
                    ColorRef(0xCC, 0xCC, 0xCC),
                    ColorRef(0x76, 0x76, 0x76),
                    ColorRef(0xE7, 0x48, 0x56),
                    ColorRef(0x16, 0xC6, 0x0C),
                    ColorRef(0xF9, 0xF1, 0xA5),
                    ColorRef(0x3B, 0x78, 0xFF),
                    ColorRef(0xB4, 0x00, 0x9E),
                    ColorRef(0x61, 0xD6, 0xD6),
                    ColorRef(0xF2, 0xF2, 0xF2),
                ],
            },
            "Cascadia Mono",
            14,
            Color.FromRgb(0x0C, 0x0C, 0x0C));
    }

    private static uint ColorRef(byte red, byte green, byte blue)
    {
        // Win32 COLORREF is 0x00BBGGRR.
        return (uint)(red | (green << 8) | (blue << 16));
    }

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
