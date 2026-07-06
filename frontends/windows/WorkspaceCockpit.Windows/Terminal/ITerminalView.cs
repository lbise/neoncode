namespace WorkspaceCockpit.Windows.Terminal;

public interface ITerminalView
{
    event Action<byte[]>? Input;
    event Action<uint, uint>? Resized;

    void Write(byte[] data);
    void Resize(uint columns, uint rows);
    void Clear();
}
