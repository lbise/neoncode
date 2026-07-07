using System.Windows;

namespace NeonCode.ElectronTerminalHost;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        var options = HostOptions.Parse(e.Args);
        var window = new MainWindow(options);
        window.Show();
    }
}
