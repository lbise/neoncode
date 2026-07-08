#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>

namespace wt
{
    using CoordType = std::int32_t;

    struct Size
    {
        CoordType width;
        CoordType height;
    };

    struct TerminalTheme
    {
        COLORREF DefaultBackground;
        COLORREF DefaultForeground;
        COLORREF DefaultSelectionBackground;
        std::uint32_t CursorStyle;
        COLORREF ColorTable[16];
    };

    using CreateTerminalFn = HRESULT(__stdcall*)(HWND parentHwnd, void** hwnd, void** terminal);
    using DestroyTerminalFn = void(__stdcall*)(void* terminal);
    using TerminalTriggerResizeFn = HRESULT(__stdcall*)(void* terminal, CoordType width, CoordType height, Size* dimensions);
    using TerminalDpiChangedFn = void(__stdcall*)(void* terminal, int newDpi);
    using TerminalSetThemeFn = void(__stdcall*)(void* terminal, TerminalTheme theme, LPCWSTR fontFamily, CoordType fontSize, int newDpi);
    using WriteCallbackFn = void(__stdcall*)(wchar_t*);
    using TerminalRegisterWriteCallbackFn = void(__stdcall*)(void* terminal, WriteCallbackFn callback);
    using TerminalSendOutputFn = void(__stdcall*)(void* terminal, LPCWSTR data);
    using TerminalSendKeyEventFn = void(__stdcall*)(void* terminal, WORD vkey, WORD scanCode, WORD flags, bool keyDown);
    using TerminalSendCharEventFn = void(__stdcall*)(void* terminal, wchar_t ch, WORD flags, WORD scanCode);
    using TerminalSetFocusFn = void(__stdcall*)(void* terminal);
    using TerminalKillFocusFn = void(__stdcall*)(void* terminal);
}

struct HostOptions
{
    HWND parentHwnd{};
    int topOffset{ 52 };
    int columnIndex{};
    int columnCount{ 1 };
    int columnGap{};
};

struct TerminalExports
{
    HMODULE module{};
    wt::CreateTerminalFn CreateTerminal{};
    wt::DestroyTerminalFn DestroyTerminal{};
    wt::TerminalTriggerResizeFn TerminalTriggerResize{};
    wt::TerminalDpiChangedFn TerminalDpiChanged{};
    wt::TerminalSetThemeFn TerminalSetTheme{};
    wt::TerminalRegisterWriteCallbackFn TerminalRegisterWriteCallback{};
    wt::TerminalSendOutputFn TerminalSendOutput{};
    wt::TerminalSendKeyEventFn TerminalSendKeyEvent{};
    wt::TerminalSendCharEventFn TerminalSendCharEvent{};
    wt::TerminalSetFocusFn TerminalSetFocus{};
    wt::TerminalKillFocusFn TerminalKillFocus{};
};

static HostOptions g_options{};
static TerminalExports g_exports{};
static HWND g_terminalHwnd{};
static void* g_terminal{};
static WNDPROC g_originalTerminalProc{};
static bool g_focused{};
static wt::Size g_lastCellSize{};
static int g_lastDpi{};
static bool g_hasExplicitBounds{};
static bool g_hasAppliedBounds{};
static RECT g_explicitBounds{};
static RECT g_appliedBounds{};
static int g_explicitDpi{};

struct BoundsCommand
{
    RECT bounds{};
    int dpi{};
};

static constexpr UINT WM_NEONCODE_FOCUS_TERMINAL = WM_APP + 1;
static constexpr UINT WM_NEONCODE_BLUR_TERMINAL = WM_APP + 2;
static constexpr UINT WM_NEONCODE_SET_BOUNDS = WM_APP + 3;

static std::wstring GetArgValue(std::wstring_view arg, std::wstring_view name)
{
    const auto prefix = std::wstring(name) + L"=";
    if (arg.rfind(prefix, 0) == 0)
    {
        return std::wstring(arg.substr(prefix.size()));
    }
    return {};
}

static int ParseIntOrDefault(const std::wstring& value, int fallback)
{
    if (value.empty())
    {
        return fallback;
    }

    try
    {
        return std::stoi(value);
    }
    catch (...)
    {
        return fallback;
    }
}

static HostOptions ParseOptions()
{
    HostOptions options{};

    int argc = 0;
    auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv)
    {
        return options;
    }

    for (int i = 1; i < argc; ++i)
    {
        const std::wstring_view arg{ argv[i] };
        auto value = GetArgValue(arg, L"--parent-hwnd");
        if (!value.empty())
        {
            options.parentHwnd = reinterpret_cast<HWND>(_wcstoui64(value.c_str(), nullptr, 10));
            continue;
        }

        value = GetArgValue(arg, L"--top-offset");
        if (!value.empty())
        {
            options.topOffset = std::max(0, ParseIntOrDefault(value, options.topOffset));
            continue;
        }

        value = GetArgValue(arg, L"--column-index");
        if (!value.empty())
        {
            options.columnIndex = std::max(0, ParseIntOrDefault(value, options.columnIndex));
            continue;
        }

        value = GetArgValue(arg, L"--column-count");
        if (!value.empty())
        {
            options.columnCount = std::max(1, ParseIntOrDefault(value, options.columnCount));
            continue;
        }

        value = GetArgValue(arg, L"--column-gap");
        if (!value.empty())
        {
            options.columnGap = std::max(0, ParseIntOrDefault(value, options.columnGap));
            continue;
        }
    }

    options.columnIndex = std::min(options.columnIndex, options.columnCount - 1);
    LocalFree(argv);
    return options;
}

static FARPROC RequireProc(HMODULE module, const char* name)
{
    const auto proc = GetProcAddress(module, name);
    if (!proc)
    {
        std::wstringstream message;
        message << L"Microsoft.Terminal.Control.dll is missing export: " << name;
        MessageBoxW(nullptr, message.str().c_str(), L"NeonCode Native Coordinator", MB_ICONERROR | MB_OK);
    }
    return proc;
}

static bool LoadTerminalExports()
{
    auto module = LoadLibraryW(L"Microsoft.Terminal.Control.dll");
    if (!module)
    {
        MessageBoxW(nullptr, L"Failed to load Microsoft.Terminal.Control.dll. Ensure the coordinator runs next to the Windows Terminal control files.", L"NeonCode Native Coordinator", MB_ICONERROR | MB_OK);
        return false;
    }

    g_exports.module = module;
    g_exports.CreateTerminal = reinterpret_cast<wt::CreateTerminalFn>(RequireProc(module, "CreateTerminal"));
    g_exports.DestroyTerminal = reinterpret_cast<wt::DestroyTerminalFn>(RequireProc(module, "DestroyTerminal"));
    g_exports.TerminalTriggerResize = reinterpret_cast<wt::TerminalTriggerResizeFn>(RequireProc(module, "TerminalTriggerResize"));
    g_exports.TerminalDpiChanged = reinterpret_cast<wt::TerminalDpiChangedFn>(RequireProc(module, "TerminalDpiChanged"));
    g_exports.TerminalSetTheme = reinterpret_cast<wt::TerminalSetThemeFn>(RequireProc(module, "TerminalSetTheme"));
    g_exports.TerminalRegisterWriteCallback = reinterpret_cast<wt::TerminalRegisterWriteCallbackFn>(RequireProc(module, "TerminalRegisterWriteCallback"));
    g_exports.TerminalSendOutput = reinterpret_cast<wt::TerminalSendOutputFn>(RequireProc(module, "TerminalSendOutput"));
    g_exports.TerminalSendKeyEvent = reinterpret_cast<wt::TerminalSendKeyEventFn>(RequireProc(module, "TerminalSendKeyEvent"));
    g_exports.TerminalSendCharEvent = reinterpret_cast<wt::TerminalSendCharEventFn>(RequireProc(module, "TerminalSendCharEvent"));
    g_exports.TerminalSetFocus = reinterpret_cast<wt::TerminalSetFocusFn>(RequireProc(module, "TerminalSetFocus"));
    g_exports.TerminalKillFocus = reinterpret_cast<wt::TerminalKillFocusFn>(RequireProc(module, "TerminalKillFocus"));

    return g_exports.CreateTerminal &&
           g_exports.DestroyTerminal &&
           g_exports.TerminalTriggerResize &&
           g_exports.TerminalDpiChanged &&
           g_exports.TerminalSetTheme &&
           g_exports.TerminalRegisterWriteCallback &&
           g_exports.TerminalSendOutput &&
           g_exports.TerminalSendKeyEvent &&
           g_exports.TerminalSendCharEvent &&
           g_exports.TerminalSetFocus &&
           g_exports.TerminalKillFocus;
}

static WORD CurrentModifierFlags(bool enhancedKey)
{
    WORD flags = 0;
    if (GetKeyState(VK_SHIFT) & 0x8000)
    {
        flags |= SHIFT_PRESSED;
    }
    if (GetKeyState(VK_CONTROL) & 0x8000)
    {
        flags |= LEFT_CTRL_PRESSED;
    }
    if (GetKeyState(VK_MENU) & 0x8000)
    {
        flags |= LEFT_ALT_PRESSED;
    }
    if (GetKeyState(VK_CAPITAL) & 0x0001)
    {
        flags |= CAPSLOCK_ON;
    }
    if (GetKeyState(VK_NUMLOCK) & 0x0001)
    {
        flags |= NUMLOCK_ON;
    }
    if (enhancedKey)
    {
        flags |= ENHANCED_KEY;
    }
    return flags;
}

static void ApplyTheme()
{
    wt::TerminalTheme theme{};
    theme.DefaultBackground = RGB(12, 12, 12);
    theme.DefaultForeground = RGB(204, 204, 204);
    theme.DefaultSelectionBackground = RGB(38, 79, 120);
    theme.CursorStyle = 1;

    const COLORREF table[16] = {
        RGB(12, 12, 12), RGB(197, 15, 31), RGB(19, 161, 14), RGB(193, 156, 0),
        RGB(0, 55, 218), RGB(136, 23, 152), RGB(58, 150, 221), RGB(204, 204, 204),
        RGB(118, 118, 118), RGB(231, 72, 86), RGB(22, 198, 12), RGB(249, 241, 165),
        RGB(59, 120, 255), RGB(180, 0, 158), RGB(97, 214, 214), RGB(242, 242, 242),
    };
    std::copy(std::begin(table), std::end(table), std::begin(theme.ColorTable));

    const auto dpi = GetDpiForWindow(g_terminalHwnd ? g_terminalHwnd : g_options.parentHwnd);
    g_lastDpi = static_cast<int>(dpi);
    g_exports.TerminalSetTheme(g_terminal, theme, L"Consolas", 14, g_lastDpi);
}

static RECT CalculateBounds(const RECT& parentClient)
{
    const auto parentWidth = std::max(1L, parentClient.right - parentClient.left);
    const auto parentHeight = std::max(1L, parentClient.bottom - parentClient.top);
    const auto top = std::clamp<long>(g_options.topOffset, 0, std::max(0L, parentHeight - 1));
    const auto height = std::max(1L, parentHeight - top);
    const auto gapTotal = g_options.columnGap * std::max(0, g_options.columnCount - 1);
    const auto availableWidth = std::max(1L, parentWidth - gapTotal);
    const auto baseWidth = std::max(1L, availableWidth / g_options.columnCount);
    const auto left = g_options.columnIndex * (baseWidth + g_options.columnGap);
    const auto width = g_options.columnIndex == g_options.columnCount - 1 ? std::max(1L, parentWidth - left) : baseWidth;

    return RECT{ left, top, left + width, top + height };
}

static bool SameRect(const RECT& left, const RECT& right)
{
    return left.left == right.left &&
           left.top == right.top &&
           left.right == right.right &&
           left.bottom == right.bottom;
}

static void ApplyBounds(const RECT& bounds, int dpi)
{
    if (!g_terminalHwnd || !g_terminal)
    {
        return;
    }

    const auto width = std::max(1L, bounds.right - bounds.left);
    const auto height = std::max(1L, bounds.bottom - bounds.top);
    const auto sizeChanged = !g_hasAppliedBounds || !SameRect(bounds, g_appliedBounds);

    ShowWindow(g_terminalHwnd, SW_SHOW);
    if (sizeChanged)
    {
        SetWindowPos(g_terminalHwnd, HWND_TOP, bounds.left, bounds.top, width, height, SWP_SHOWWINDOW);
        g_appliedBounds = bounds;
        g_hasAppliedBounds = true;
    }

    if (dpi > 0 && dpi != g_lastDpi)
    {
        g_lastDpi = dpi;
        g_exports.TerminalDpiChanged(g_terminal, dpi);
    }

    if (sizeChanged)
    {
        wt::Size cellSize{};
        if (SUCCEEDED(g_exports.TerminalTriggerResize(g_terminal, static_cast<wt::CoordType>(width), static_cast<wt::CoordType>(height), &cellSize)))
        {
            g_lastCellSize = cellSize;
        }
    }
}

static void RefreshBounds()
{
    if (!g_options.parentHwnd || !g_terminalHwnd || !g_terminal)
    {
        return;
    }

    if (!IsWindow(g_options.parentHwnd))
    {
        PostQuitMessage(0);
        return;
    }

    if (IsIconic(g_options.parentHwnd))
    {
        ShowWindow(g_terminalHwnd, SW_HIDE);
        return;
    }

    if (g_hasExplicitBounds)
    {
        ApplyBounds(g_explicitBounds, g_explicitDpi > 0 ? g_explicitDpi : g_lastDpi);
        return;
    }

    RECT parentClient{};
    if (!GetClientRect(g_options.parentHwnd, &parentClient))
    {
        return;
    }

    const auto bounds = CalculateBounds(parentClient);
    const auto dpi = static_cast<int>(GetDpiForWindow(g_options.parentHwnd));
    ApplyBounds(bounds, dpi);
}

static bool IsParentForeground()
{
    if (!g_options.parentHwnd)
    {
        return true;
    }

    const auto foreground = GetForegroundWindow();
    if (!foreground)
    {
        return false;
    }

    return foreground == g_options.parentHwnd || GetAncestor(foreground, GA_ROOT) == g_options.parentHwnd;
}

static void FocusTerminal()
{
    if (!g_terminalHwnd || !g_terminal || !IsParentForeground())
    {
        return;
    }

    SetFocus(g_terminalHwnd);
    g_exports.TerminalSetFocus(g_terminal);
    g_focused = true;
}

static void BlurTerminal()
{
    if (!g_terminal || !g_focused)
    {
        return;
    }

    g_exports.TerminalKillFocus(g_terminal);
    g_focused = false;
}

static DWORD WINAPI ControlPipeThread(void*)
{
    const auto input = GetStdHandle(STD_INPUT_HANDLE);
    if (!input || input == INVALID_HANDLE_VALUE)
    {
        return 0;
    }

    std::string pending;
    char buffer[256]{};
    DWORD bytesRead = 0;
    while (ReadFile(input, buffer, sizeof(buffer), &bytesRead, nullptr) && bytesRead > 0)
    {
        pending.append(buffer, buffer + bytesRead);
        for (;;)
        {
            const auto newline = pending.find('\n');
            if (newline == std::string::npos)
            {
                break;
            }

            auto line = pending.substr(0, newline);
            pending.erase(0, newline + 1);
            if (!line.empty() && line.back() == '\r')
            {
                line.pop_back();
            }

            if (line.rfind("bounds", 0) == 0 && g_terminalHwnd)
            {
                std::istringstream stream{ line };
                std::string command;
                long x = 0;
                long y = 0;
                long width = 0;
                long height = 0;
                int dpi = 96;
                if (stream >> command >> x >> y >> width >> height >> dpi)
                {
                    const auto bounds = new BoundsCommand{
                        RECT{ x, y, x + std::max(1L, width), y + std::max(1L, height) },
                        dpi,
                    };
                    PostMessageW(g_terminalHwnd, WM_NEONCODE_SET_BOUNDS, 0, reinterpret_cast<LPARAM>(bounds));
                }
            }
            else if (line.rfind("focus", 0) == 0 && g_terminalHwnd)
            {
                PostMessageW(g_terminalHwnd, WM_NEONCODE_FOCUS_TERMINAL, 0, 0);
            }
            else if (line.rfind("blur", 0) == 0 && g_terminalHwnd)
            {
                PostMessageW(g_terminalHwnd, WM_NEONCODE_BLUR_TERMINAL, 0, 0);
            }
        }
    }

    return 0;
}

static void SendIntroText()
{
    g_exports.TerminalSendOutput(
        g_terminal,
        L"\x1b[36mNeonCode direct HwndTerminal coordinator POC\x1b[0m\r\n"
        L"This bypasses WPF and calls Microsoft.Terminal.Control.dll HwndTerminal exports directly.\r\n"
        L"Hub/PTTY integration is intentionally not wired yet; keyboard input is echoed locally.\r\n\r\n");
}

static void __stdcall TerminalWriteCallback(wchar_t* text)
{
    if (!text)
    {
        return;
    }

    if (g_terminal && g_exports.TerminalSendOutput)
    {
        g_exports.TerminalSendOutput(g_terminal, text);
    }

    CoTaskMemFree(text);
}

static LRESULT CALLBACK TerminalSubclassProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_NEONCODE_FOCUS_TERMINAL:
        RefreshBounds();
        FocusTerminal();
        return 0;

    case WM_NEONCODE_BLUR_TERMINAL:
        BlurTerminal();
        return 0;

    case WM_NEONCODE_SET_BOUNDS:
        if (lParam)
        {
            const std::unique_ptr<BoundsCommand> command{ reinterpret_cast<BoundsCommand*>(lParam) };
            g_explicitBounds = command->bounds;
            g_explicitDpi = command->dpi;
            g_hasExplicitBounds = true;
            ApplyBounds(g_explicitBounds, g_explicitDpi);
        }
        return 0;

    case WM_TIMER:
        RefreshBounds();
        return 0;

    case WM_SETFOCUS:
        FocusTerminal();
        break;

    case WM_KILLFOCUS:
        BlurTerminal();
        break;

    case WM_LBUTTONDOWN:
    case WM_MBUTTONDOWN:
    case WM_RBUTTONDOWN:
        FocusTerminal();
        break;

    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
    case WM_KEYUP:
    case WM_SYSKEYUP:
        if (g_terminal)
        {
            const auto keyDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            const auto scanCode = static_cast<WORD>((lParam >> 16) & 0xff);
            const auto enhanced = (lParam & (1 << 24)) != 0;
            g_exports.TerminalSendKeyEvent(g_terminal, static_cast<WORD>(wParam), scanCode, CurrentModifierFlags(enhanced), keyDown);
            return 0;
        }
        break;

    case WM_CHAR:
    case WM_SYSCHAR:
        if (g_terminal)
        {
            const auto scanCode = static_cast<WORD>((lParam >> 16) & 0xff);
            g_exports.TerminalSendCharEvent(g_terminal, static_cast<wchar_t>(wParam), CurrentModifierFlags(false), scanCode);
            return 0;
        }
        break;

    case WM_DESTROY:
        KillTimer(hwnd, 1);
        break;
    }

    return CallWindowProcW(g_originalTerminalProc, hwnd, message, wParam, lParam);
}

static bool CreateDirectTerminal()
{
    if (!g_options.parentHwnd || !IsWindow(g_options.parentHwnd))
    {
        MessageBoxW(nullptr, L"Invalid or missing --parent-hwnd.", L"NeonCode Native Coordinator", MB_ICONERROR | MB_OK);
        return false;
    }

    void* hwndValue{};
    void* terminalValue{};
    const auto hr = g_exports.CreateTerminal(g_options.parentHwnd, &hwndValue, &terminalValue);
    if (FAILED(hr) || !hwndValue || !terminalValue)
    {
        MessageBoxW(nullptr, L"CreateTerminal failed.", L"NeonCode Native Coordinator", MB_ICONERROR | MB_OK);
        return false;
    }

    g_terminalHwnd = static_cast<HWND>(hwndValue);
    g_terminal = terminalValue;

    g_originalTerminalProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(g_terminalHwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(TerminalSubclassProc)));

    auto style = GetWindowLongPtrW(g_terminalHwnd, GWL_STYLE);
    style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE;
    SetWindowLongPtrW(g_terminalHwnd, GWL_STYLE, style);

    g_exports.TerminalRegisterWriteCallback(g_terminal, TerminalWriteCallback);
    ApplyTheme();
    RefreshBounds();
    SendIntroText();
    SetTimer(g_terminalHwnd, 1, 33, nullptr);
    if (const auto controlThread = CreateThread(nullptr, 0, ControlPipeThread, nullptr, 0, nullptr))
    {
        CloseHandle(controlThread);
    }

    return true;
}

static void DestroyDirectTerminal()
{
    if (g_terminalHwnd)
    {
        KillTimer(g_terminalHwnd, 1);
    }

    if (g_terminal)
    {
        g_exports.DestroyTerminal(g_terminal);
        g_terminal = nullptr;
        g_terminalHwnd = nullptr;
    }

    if (g_exports.module)
    {
        FreeLibrary(g_exports.module);
        g_exports = {};
    }
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int)
{
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    g_options = ParseOptions();
    if (!LoadTerminalExports() || !CreateDirectTerminal())
    {
        DestroyDirectTerminal();
        CoUninitialize();
        return 1;
    }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0)
    {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    DestroyDirectTerminal();
    CoUninitialize();
    return 0;
}
