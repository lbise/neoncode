using System.Text;
using System.Windows.Controls;
using System.Windows.Threading;

namespace NeonCode.Windows.Terminal;

public sealed class TextBoxTerminalView : ITerminalView
{
    private readonly TextBox textBox;
    private readonly Dispatcher dispatcher;

    public TextBoxTerminalView(TextBox textBox)
    {
        this.textBox = textBox;
        dispatcher = textBox.Dispatcher;
    }

#pragma warning disable CS0067 // Placeholder implementation does not emit terminal-native input/resize events.
    public event Action<byte[]>? Input;
    public event Action<uint, uint>? Resized;
#pragma warning restore CS0067

    public void Write(byte[] data)
    {
        var text = Encoding.UTF8.GetString(data);
        dispatcher.Invoke(() =>
        {
            textBox.AppendText(text.Replace("\n", "\r\n"));
            textBox.ScrollToEnd();
        });
    }

    public void Resize(uint columns, uint rows)
    {
        // The placeholder text box is not a real terminal renderer, so there is no grid to resize.
        // A real Windows Terminal adapter will emit Resized events and apply dimensions here.
    }

    public void Clear()
    {
        dispatcher.Invoke(textBox.Clear);
    }
}
