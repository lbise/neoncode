# NeonCode issues/improvements

## Issues

- I'm not sure that kill/detach pane is a thing, basically user should open tab, and close them (kill). As long as a tab exists we re-attach if needed. Once the user close it we kill it. Add an option to enable an optional confirmation when closing a tab (disabled by default). Just get rid of the concept of detaching.
- In the same vein, do not ask what to do when closing tab, by default kill the tab
- Get rid of the text when opening a terminal as well as the concept of having the user able to change the electron-xterm-shell-session prefix, we don't care this is an internal thing just hide it and don't show it. Same as the websocket address thing. We don't care about this. See example.

```
NeonCode
Connecting electron-xterm-shell-session-0ffc182b-ff3a-4616-b06b-5e3ded18c312 to ws://127.0.0.1:44777/wsNeonCode
```

## Improvements

- Dynamically reload config.json when changes are detected
- Tabs should appear below workspace in the sidebar
- Vertical space is very precious, currently there is a lot of it is wasted, window top bar (with minimize/restore/close window buttons) then a NeonCode bar with commands palette and settings button then the list of tabs then a border around the terminal window itself with name + status and split/close/more buttons. We should get rid of all of these.
  - Let's make use of the window bar to add a settings (cogwheel) icon to access the settings
  - A search field in the middle of the bar to access the command palette
  - Drop the Workspace/Session cockpit string from the app bar as well as the commands and settings button obviously and the Connected to \*\*\*\* string.
  - Think minimalism when designing this interface (use your hallmark skill)
  - Since we are moving the tabs icons under the workspace (by the way make the workspace button only show the name (drop the WSL and and git string) you can keep the number of tabs that are connected (like 3 tabs, we don't care about the status (running etc...)) Remove the tab buttons above the terminal as well as the + Tab button. We must add left click menu on the workspace name that allows us to rename workspace/delete workspace, create new tabs etc...
  - Drop the boarder around the terminal with name status split/close/more buttons. We need just a close x next to the name below the workspace
- By default add the possibility to bind workspace 0-9 always even if they don't exist. Same for panes.
- We need to create the possibility to theme this application. We want VERY simple themes, like one at most two background colors (sidebar + background), text color, and maybe 3 accent colors ? Feel free to suggest something. This should be configurable from the settings menu.
- Opening the settings should create a new special workspace with a single settings window instead of a modal on top
- Terminal scroll bar is ugly as sin, it should use the same background color than the rest.
- Replace the cyan accent color for NeonCode by a bright pink one
- When switching tabs, it looks like some stuff is re-run in the terminals this is very bad as I can see stuff being executed, why do we need it? Same when resizing etc... This is very bad.
