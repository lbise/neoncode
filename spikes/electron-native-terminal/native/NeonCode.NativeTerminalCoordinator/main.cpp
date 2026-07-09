#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <objbase.h>
#include <winhttp.h>
#include <process.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstdarg>
#include <cwchar>
#include <cstdio>
#include <atomic>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

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
    std::wstring endpoint{ L"ws://127.0.0.1:44777/ws" };
    std::wstring command{ L"bash" };
    std::wstring sessionId{ L"electron-spike-shell" };
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
static std::mutex g_webSocketMutex{};
static HINTERNET g_webSocket{};
static std::atomic_bool g_hubConnected{};
static std::atomic_bool g_hubStopRequested{};

struct BoundsCommand
{
    RECT bounds{};
    int dpi{};
};

static constexpr UINT WM_NEONCODE_FOCUS_TERMINAL = WM_APP + 1;
static constexpr UINT WM_NEONCODE_BLUR_TERMINAL = WM_APP + 2;
static constexpr UINT WM_NEONCODE_SET_BOUNDS = WM_APP + 3;
static constexpr UINT WM_NEONCODE_TERMINAL_OUTPUT = WM_APP + 4;

static std::wstring g_logPath{};

static void SendHubResize(wt::Size cellSize);

static std::wstring HwndToString(HWND hwnd)
{
    wchar_t buffer[32]{};
    swprintf_s(buffer, L"0x%p", hwnd);
    return buffer;
}

static void InitializeLogPath()
{
    wchar_t tempPath[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, tempPath))
    {
        wcscpy_s(tempPath, L"C:\\Windows\\Temp\\");
    }

    std::wstring logDir = tempPath;
    logDir += L"NeonCode";
    CreateDirectoryW(logDir.c_str(), nullptr);

    wchar_t fileName[128]{};
    swprintf_s(fileName, L"direct-coordinator-%lu-pane-%d.log", GetCurrentProcessId(), g_options.columnIndex + 1);
    g_logPath = logDir + L"\\" + fileName;
}

static void Log(const wchar_t* message)
{
    if (g_logPath.empty())
    {
        return;
    }

    FILE* file = nullptr;
    if (_wfopen_s(&file, g_logPath.c_str(), L"a, ccs=UTF-8") != 0 || !file)
    {
        return;
    }

    SYSTEMTIME now{};
    GetLocalTime(&now);
    fwprintf(
        file,
        L"%04hu-%02hu-%02huT%02hu:%02hu:%02hu.%03hu %s\n",
        now.wYear,
        now.wMonth,
        now.wDay,
        now.wHour,
        now.wMinute,
        now.wSecond,
        now.wMilliseconds,
        message);
    fclose(file);
}

static void LogFormat(const wchar_t* format, ...)
{
    wchar_t buffer[1024]{};
    va_list args;
    va_start(args, format);
    vswprintf_s(buffer, format, args);
    va_end(args);
    Log(buffer);
}

static void WriteCoordinatorEvent(const std::string& line)
{
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!output || output == INVALID_HANDLE_VALUE)
    {
        return;
    }

    DWORD written = 0;
    const auto payload = line + "\n";
    WriteFile(output, payload.data(), static_cast<DWORD>(payload.size()), &written, nullptr);
}

static std::string WideToUtf8(const std::wstring_view value)
{
    if (value.empty())
    {
        return {};
    }

    const auto size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0)
    {
        return {};
    }

    std::string result(static_cast<std::size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
    return result;
}

static std::wstring Utf8ToWide(const std::string_view value)
{
    if (value.empty())
    {
        return {};
    }

    auto size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0)
    {
        std::wstring fallback;
        fallback.reserve(value.size());
        for (const auto ch : value)
        {
            fallback.push_back(static_cast<unsigned char>(ch));
        }
        return fallback;
    }

    std::wstring result(static_cast<std::size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size);
    return result;
}

static std::string JsonEscape(const std::string_view value)
{
    std::string escaped;
    escaped.reserve(value.size() + 8);
    for (const auto ch : value)
    {
        switch (ch)
        {
        case '"': escaped += "\\\""; break;
        case '\\': escaped += "\\\\"; break;
        case '\b': escaped += "\\b"; break;
        case '\f': escaped += "\\f"; break;
        case '\n': escaped += "\\n"; break;
        case '\r': escaped += "\\r"; break;
        case '\t': escaped += "\\t"; break;
        default:
            if (static_cast<unsigned char>(ch) < 0x20)
            {
                char buffer[7]{};
                sprintf_s(buffer, "\\u%04x", static_cast<unsigned char>(ch));
                escaped += buffer;
            }
            else
            {
                escaped.push_back(ch);
            }
            break;
        }
    }
    return escaped;
}

static std::string JsonStringValue(const std::string& json, const std::string& name)
{
    const auto key = "\"" + name + "\"";
    auto pos = json.find(key);
    if (pos == std::string::npos)
    {
        return {};
    }

    pos = json.find(':', pos + key.size());
    if (pos == std::string::npos)
    {
        return {};
    }

    pos = json.find('"', pos + 1);
    if (pos == std::string::npos)
    {
        return {};
    }

    std::string value;
    for (std::size_t i = pos + 1; i < json.size(); ++i)
    {
        const auto ch = json[i];
        if (ch == '"')
        {
            return value;
        }
        if (ch == '\\' && i + 1 < json.size())
        {
            const auto escaped = json[++i];
            switch (escaped)
            {
            case '"': value.push_back('"'); break;
            case '\\': value.push_back('\\'); break;
            case '/': value.push_back('/'); break;
            case 'b': value.push_back('\b'); break;
            case 'f': value.push_back('\f'); break;
            case 'n': value.push_back('\n'); break;
            case 'r': value.push_back('\r'); break;
            case 't': value.push_back('\t'); break;
            default: value.push_back(escaped); break;
            }
        }
        else
        {
            value.push_back(ch);
        }
    }

    return {};
}

static std::string Base64Encode(const std::string_view bytes)
{
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string encoded;
    encoded.reserve(((bytes.size() + 2) / 3) * 4);

    for (std::size_t i = 0; i < bytes.size(); i += 3)
    {
        const auto b0 = static_cast<unsigned char>(bytes[i]);
        const auto b1 = i + 1 < bytes.size() ? static_cast<unsigned char>(bytes[i + 1]) : 0;
        const auto b2 = i + 2 < bytes.size() ? static_cast<unsigned char>(bytes[i + 2]) : 0;

        encoded.push_back(alphabet[b0 >> 2]);
        encoded.push_back(alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]);
        encoded.push_back(i + 1 < bytes.size() ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=');
        encoded.push_back(i + 2 < bytes.size() ? alphabet[b2 & 0x3f] : '=');
    }

    return encoded;
}

static int Base64Value(char ch)
{
    if (ch >= 'A' && ch <= 'Z') return ch - 'A';
    if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
    if (ch >= '0' && ch <= '9') return ch - '0' + 52;
    if (ch == '+') return 62;
    if (ch == '/') return 63;
    return -1;
}

static std::string Base64Decode(const std::string& encoded)
{
    std::string decoded;
    int value = 0;
    int bits = -8;
    for (const auto ch : encoded)
    {
        if (ch == '=')
        {
            break;
        }

        const auto digit = Base64Value(ch);
        if (digit < 0)
        {
            continue;
        }

        value = (value << 6) | digit;
        bits += 6;
        if (bits >= 0)
        {
            decoded.push_back(static_cast<char>((value >> bits) & 0xff));
            bits -= 8;
        }
    }
    return decoded;
}

static void PostTerminalOutput(const std::wstring& text)
{
    if (!g_terminalHwnd)
    {
        return;
    }

    auto payload = new std::wstring(text);
    if (!PostMessageW(g_terminalHwnd, WM_NEONCODE_TERMINAL_OUTPUT, 0, reinterpret_cast<LPARAM>(payload)))
    {
        delete payload;
    }
}

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

        value = GetArgValue(arg, L"--endpoint");
        if (!value.empty())
        {
            options.endpoint = value;
            continue;
        }

        value = GetArgValue(arg, L"--command");
        if (!value.empty())
        {
            options.command = value;
            continue;
        }

        value = GetArgValue(arg, L"--session-id");
        if (!value.empty())
        {
            options.sessionId = value;
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
    Log(L"LoadTerminalExports.begin");
    auto module = LoadLibraryW(L"Microsoft.Terminal.Control.dll");
    if (!module)
    {
        LogFormat(L"LoadTerminalExports.failed error=%lu", GetLastError());
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

    const auto loaded = g_exports.CreateTerminal &&
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
    LogFormat(L"LoadTerminalExports.end loaded=%d", loaded ? 1 : 0);
    return loaded;
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
    LogFormat(L"ApplyTheme dpi=%d", g_lastDpi);
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
        LogFormat(L"ApplyBounds x=%ld y=%ld width=%ld height=%ld dpi=%d", bounds.left, bounds.top, width, height, dpi);
        SetWindowPos(g_terminalHwnd, HWND_TOP, bounds.left, bounds.top, width, height, SWP_SHOWWINDOW);
        g_appliedBounds = bounds;
        g_hasAppliedBounds = true;
    }

    if (dpi > 0 && dpi != g_lastDpi)
    {
        LogFormat(L"ApplyBounds.dpiChanged old=%d new=%d", g_lastDpi, dpi);
        g_lastDpi = dpi;
        g_exports.TerminalDpiChanged(g_terminal, dpi);
    }

    if (sizeChanged)
    {
        wt::Size cellSize{};
        const auto hr = g_exports.TerminalTriggerResize(g_terminal, static_cast<wt::CoordType>(width), static_cast<wt::CoordType>(height), &cellSize);
        if (SUCCEEDED(hr))
        {
            LogFormat(L"ApplyBounds.resize cells=%ldx%ld", cellSize.width, cellSize.height);
            g_lastCellSize = cellSize;
            SendHubResize(cellSize);
        }
        else
        {
            LogFormat(L"ApplyBounds.resize.failed hr=0x%08lx", static_cast<unsigned long>(hr));
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
        Log(L"RefreshBounds.parentMinimized hide");
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
    const auto foreground = GetForegroundWindow();
    const auto parentForeground = IsParentForeground();
    LogFormat(
        L"FocusTerminal requested terminal=%s parent=%s foreground=%s parentForeground=%d focused=%d",
        HwndToString(g_terminalHwnd).c_str(),
        HwndToString(g_options.parentHwnd).c_str(),
        HwndToString(foreground).c_str(),
        parentForeground ? 1 : 0,
        g_focused ? 1 : 0);

    if (!g_terminalHwnd || !g_terminal || !parentForeground)
    {
        Log(L"FocusTerminal skipped");
        return;
    }

    const auto previousFocus = SetFocus(g_terminalHwnd);
    g_exports.TerminalSetFocus(g_terminal);
    g_focused = true;
    LogFormat(L"FocusTerminal applied previousFocus=%s currentFocus=%s", HwndToString(previousFocus).c_str(), HwndToString(GetFocus()).c_str());
    WriteCoordinatorEvent("focus_changed " + std::to_string(g_options.columnIndex));
}

static void BlurTerminal()
{
    LogFormat(L"BlurTerminal requested focused=%d currentFocus=%s", g_focused ? 1 : 0, HwndToString(GetFocus()).c_str());
    if (!g_terminal || !g_focused)
    {
        Log(L"BlurTerminal skipped");
        return;
    }

    g_exports.TerminalKillFocus(g_terminal);
    g_focused = false;
    Log(L"BlurTerminal applied");
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
                LogFormat(L"ControlPipe.command bounds raw='%S'", line.c_str());
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
                LogFormat(L"ControlPipe.command focus raw='%S'", line.c_str());
                PostMessageW(g_terminalHwnd, WM_NEONCODE_FOCUS_TERMINAL, 0, 0);
            }
            else if (line.rfind("blur", 0) == 0 && g_terminalHwnd)
            {
                LogFormat(L"ControlPipe.command blur raw='%S'", line.c_str());
                PostMessageW(g_terminalHwnd, WM_NEONCODE_BLUR_TERMINAL, 0, 0);
            }
        }
    }

    return 0;
}

static bool SendHubText(const std::string& text)
{
    std::lock_guard lock{ g_webSocketMutex };
    if (!g_webSocket || !g_hubConnected.load())
    {
        Log(L"SendHubText.skipped not connected");
        return false;
    }

    const auto status = WinHttpWebSocketSend(
        g_webSocket,
        WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
        const_cast<char*>(text.data()),
        static_cast<DWORD>(text.size()));
    if (status != NO_ERROR)
    {
        LogFormat(L"SendHubText.failed status=%lu", status);
        return false;
    }

    return true;
}

static void SendHubInput(const std::wstring_view text)
{
    const auto bytes = WideToUtf8(text);
    if (bytes.empty())
    {
        return;
    }

    const auto sessionId = WideToUtf8(g_options.sessionId);
    const auto json = std::string{"{\"type\":\"input\",\"session_id\":\""} +
        JsonEscape(sessionId) +
        "\",\"data_b64\":\"" +
        Base64Encode(bytes) +
        "\"}";
    SendHubText(json);
}

static void SendHubResize(wt::Size cellSize)
{
    if (cellSize.width <= 0 || cellSize.height <= 0)
    {
        return;
    }

    const auto sessionId = WideToUtf8(g_options.sessionId);
    std::ostringstream json;
    json << "{\"type\":\"resize\",\"session_id\":\""
         << JsonEscape(sessionId)
         << "\",\"rows\":" << cellSize.height
         << ",\"cols\":" << cellSize.width
         << "}";
    SendHubText(json.str());
}

static void ProcessHubMessage(const std::string& json)
{
    const auto type = JsonStringValue(json, "type");
    if (type == "output")
    {
        const auto data = Base64Decode(JsonStringValue(json, "data_b64"));
        WriteCoordinatorEvent("hub_output " + std::to_string(g_options.columnIndex) + " " + std::to_string(data.size()));
        PostTerminalOutput(Utf8ToWide(data));
    }
    else if (type == "started")
    {
        WriteCoordinatorEvent("hub_started " + std::to_string(g_options.columnIndex));
        LogFormat(L"Hub.started session=%s", g_options.sessionId.c_str());
    }
    else if (type == "error")
    {
        const auto message = Utf8ToWide(JsonStringValue(json, "message"));
        PostTerminalOutput(L"\x1b[31mHub error: " + message + L"\x1b[0m\r\n");
    }
    else if (type == "exit")
    {
        PostTerminalOutput(L"\r\n\x1b[33mHub session exited\x1b[0m\r\n");
    }
    else if (!type.empty())
    {
        LogFormat(L"Hub.message ignored type=%S", type.c_str());
    }
}

static bool ConnectHubWebSocket(HINTERNET& internet, HINTERNET& connect, HINTERNET& request, HINTERNET& webSocket)
{
    URL_COMPONENTS components{};
    components.dwStructSize = sizeof(components);
    components.dwSchemeLength = static_cast<DWORD>(-1);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);

    auto endpoint = g_options.endpoint;
    const auto requestedSecure = endpoint.rfind(L"wss://", 0) == 0;
    std::wstring winHttpEndpoint = endpoint;
    if (winHttpEndpoint.rfind(L"ws://", 0) == 0)
    {
        winHttpEndpoint.replace(0, 5, L"http://");
    }
    else if (winHttpEndpoint.rfind(L"wss://", 0) == 0)
    {
        winHttpEndpoint.replace(0, 6, L"https://");
    }

    if (!WinHttpCrackUrl(winHttpEndpoint.data(), static_cast<DWORD>(winHttpEndpoint.size()), 0, &components))
    {
        const auto error = GetLastError();
        WriteCoordinatorEvent("hub_crack_url_failed " + std::to_string(g_options.columnIndex) + " " + std::to_string(error));
        LogFormat(L"ConnectHubWebSocket.WinHttpCrackUrl.failed error=%lu endpoint=%s", error, endpoint.c_str());
        return false;
    }

    const std::wstring host{ components.lpszHostName, components.dwHostNameLength };
    std::wstring path{ components.lpszUrlPath, components.dwUrlPathLength };
    if (components.dwExtraInfoLength > 0)
    {
        path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
    }
    if (path.empty())
    {
        path = L"/";
    }

    const auto secure = requestedSecure || components.nScheme == INTERNET_SCHEME_HTTPS;
    internet = WinHttpOpen(L"NeonCode.NativeTerminalCoordinator/0.1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!internet)
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpOpen.failed error=%lu", GetLastError());
        return false;
    }

    connect = WinHttpConnect(internet, host.c_str(), components.nPort, 0);
    if (!connect)
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpConnect.failed error=%lu host=%s port=%u", GetLastError(), host.c_str(), components.nPort);
        return false;
    }

    request = WinHttpOpenRequest(connect, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
    if (!request)
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpOpenRequest.failed error=%lu path=%s", GetLastError(), path.c_str());
        return false;
    }

    if (!WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0))
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpSetOption.failed error=%lu", GetLastError());
        return false;
    }

    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0))
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpSendRequest.failed error=%lu", GetLastError());
        return false;
    }

    if (!WinHttpReceiveResponse(request, nullptr))
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpReceiveResponse.failed error=%lu", GetLastError());
        return false;
    }

    webSocket = WinHttpWebSocketCompleteUpgrade(request, 0);
    if (!webSocket)
    {
        LogFormat(L"ConnectHubWebSocket.WinHttpWebSocketCompleteUpgrade.failed error=%lu", GetLastError());
        return false;
    }

    WinHttpCloseHandle(request);
    request = nullptr;
    return true;
}

static std::string BuildStartMessage()
{
    const auto sessionId = WideToUtf8(g_options.sessionId);
    const auto command = WideToUtf8(g_options.command);
    const auto rows = g_lastCellSize.height > 0 ? g_lastCellSize.height : 30;
    const auto cols = g_lastCellSize.width > 0 ? g_lastCellSize.width : 120;

    std::ostringstream json;
    json << "{\"type\":\"start\",\"session_id\":\""
         << JsonEscape(sessionId)
         << "\",\"command\":\""
         << JsonEscape(command)
         << "\",\"rows\":" << rows
         << ",\"cols\":" << cols
         << "}";
    return json.str();
}

static unsigned __stdcall HubThread(void*)
{
    WriteCoordinatorEvent("hub_thread_enter " + std::to_string(g_options.columnIndex));
    PostTerminalOutput(L"\x1b[36mConnecting direct coordinator to neoncode-hub...\x1b[0m\r\n");

    HINTERNET internet{};
    HINTERNET connect{};
    HINTERNET request{};
    HINTERNET webSocket{};

    if (!ConnectHubWebSocket(internet, connect, request, webSocket))
    {
        WriteCoordinatorEvent("hub_connect_failed " + std::to_string(g_options.columnIndex));
        PostTerminalOutput(L"\x1b[31mFailed to connect to neoncode-hub. Is ./dev hub running?\x1b[0m\r\n");
        if (request) WinHttpCloseHandle(request);
        if (connect) WinHttpCloseHandle(connect);
        if (internet) WinHttpCloseHandle(internet);
        return 1;
    }

    {
        std::lock_guard lock{ g_webSocketMutex };
        g_webSocket = webSocket;
        g_hubConnected = true;
    }

    WriteCoordinatorEvent("hub_connected " + std::to_string(g_options.columnIndex));
    SendHubText(BuildStartMessage());

    std::string pending;
    std::vector<char> buffer(16 * 1024);
    while (!g_hubStopRequested.load())
    {
        DWORD bytesRead = 0;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE bufferType{};
        const auto status = WinHttpWebSocketReceive(webSocket, buffer.data(), static_cast<DWORD>(buffer.size()), &bytesRead, &bufferType);
        if (status != NO_ERROR)
        {
            LogFormat(L"HubThread.receive.failed status=%lu", status);
            break;
        }

        if (bufferType == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE)
        {
            Log(L"HubThread.receive.close");
            break;
        }

        if (bufferType == WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE || bufferType == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)
        {
            pending.append(buffer.data(), buffer.data() + bytesRead);
            if (bufferType == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)
            {
                ProcessHubMessage(pending);
                pending.clear();
            }
        }
    }

    {
        std::lock_guard lock{ g_webSocketMutex };
        g_hubConnected = false;
        g_webSocket = nullptr;
    }

    if (webSocket)
    {
        WinHttpWebSocketClose(webSocket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        WinHttpCloseHandle(webSocket);
    }
    if (connect) WinHttpCloseHandle(connect);
    if (internet) WinHttpCloseHandle(internet);

    WriteCoordinatorEvent("hub_thread_end " + std::to_string(g_options.columnIndex));
    return 0;
}

static void StartHubBridge()
{
    Log(L"StartHubBridge.begin");
    g_hubStopRequested = false;
    const auto thread = reinterpret_cast<HANDLE>(_beginthreadex(nullptr, 0, HubThread, nullptr, 0, nullptr));
    if (thread)
    {
        Log(L"StartHubBridge.created");
        CloseHandle(thread);
    }
    else
    {
        LogFormat(L"StartHubBridge._beginthreadex.failed errno=%d", errno);
    }
}

static void StopHubBridge()
{
    g_hubStopRequested = true;
    std::lock_guard lock{ g_webSocketMutex };
    if (g_webSocket)
    {
        WinHttpWebSocketClose(g_webSocket, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
    }
}

static void SendIntroText()
{
    g_exports.TerminalSendOutput(
        g_terminal,
        L"\x1b[36mNeonCode direct HwndTerminal coordinator\x1b[0m\r\n");
}

static void __stdcall TerminalWriteCallback(wchar_t* text)
{
    if (!text)
    {
        return;
    }

    SendHubInput(text);
    CoTaskMemFree(text);
}

static LRESULT CALLBACK TerminalSubclassProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_NEONCODE_FOCUS_TERMINAL:
        Log(L"WM_NEONCODE_FOCUS_TERMINAL");
        RefreshBounds();
        FocusTerminal();
        return 0;

    case WM_NEONCODE_BLUR_TERMINAL:
        Log(L"WM_NEONCODE_BLUR_TERMINAL");
        BlurTerminal();
        return 0;

    case WM_NEONCODE_SET_BOUNDS:
        Log(L"WM_NEONCODE_SET_BOUNDS");
        if (lParam)
        {
            const std::unique_ptr<BoundsCommand> command{ reinterpret_cast<BoundsCommand*>(lParam) };
            g_explicitBounds = command->bounds;
            g_explicitDpi = command->dpi;
            g_hasExplicitBounds = true;
            LogFormat(L"WM_NEONCODE_SET_BOUNDS parsed x=%ld y=%ld width=%ld height=%ld dpi=%d", g_explicitBounds.left, g_explicitBounds.top, g_explicitBounds.right - g_explicitBounds.left, g_explicitBounds.bottom - g_explicitBounds.top, g_explicitDpi);
            ApplyBounds(g_explicitBounds, g_explicitDpi);
        }
        return 0;

    case WM_NEONCODE_TERMINAL_OUTPUT:
        if (lParam && g_terminal && g_exports.TerminalSendOutput)
        {
            const std::unique_ptr<std::wstring> text{ reinterpret_cast<std::wstring*>(lParam) };
            g_exports.TerminalSendOutput(g_terminal, text->c_str());
        }
        return 0;

    case WM_TIMER:
        RefreshBounds();
        return 0;

    case WM_SETFOCUS:
        LogFormat(L"WM_SETFOCUS wParam=%s", HwndToString(reinterpret_cast<HWND>(wParam)).c_str());
        FocusTerminal();
        break;

    case WM_KILLFOCUS:
        LogFormat(L"WM_KILLFOCUS wParam=%s", HwndToString(reinterpret_cast<HWND>(wParam)).c_str());
        BlurTerminal();
        break;

    case WM_LBUTTONDOWN:
    case WM_MBUTTONDOWN:
    case WM_RBUTTONDOWN:
        LogFormat(L"WM_MOUSE_BUTTON message=0x%04x", message);
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
            LogFormat(L"WM_CHAR message=0x%04x ch=0x%04x scanCode=%u", message, static_cast<unsigned int>(wParam), scanCode);
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
    LogFormat(L"CreateDirectTerminal.begin parent=%s", HwndToString(g_options.parentHwnd).c_str());
    if (!g_options.parentHwnd || !IsWindow(g_options.parentHwnd))
    {
        Log(L"CreateDirectTerminal.invalidParent");
        MessageBoxW(nullptr, L"Invalid or missing --parent-hwnd.", L"NeonCode Native Coordinator", MB_ICONERROR | MB_OK);
        return false;
    }

    void* hwndValue{};
    void* terminalValue{};
    const auto hr = g_exports.CreateTerminal(g_options.parentHwnd, &hwndValue, &terminalValue);
    if (FAILED(hr) || !hwndValue || !terminalValue)
    {
        LogFormat(L"CreateDirectTerminal.CreateTerminal.failed hr=0x%08lx hwnd=%p terminal=%p", static_cast<unsigned long>(hr), hwndValue, terminalValue);
        MessageBoxW(nullptr, L"CreateTerminal failed.", L"NeonCode Native Coordinator", MB_ICONERROR | MB_OK);
        return false;
    }

    g_terminalHwnd = static_cast<HWND>(hwndValue);
    g_terminal = terminalValue;
    LogFormat(L"CreateDirectTerminal.created terminalHwnd=%s terminal=%p", HwndToString(g_terminalHwnd).c_str(), g_terminal);

    g_originalTerminalProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(g_terminalHwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(TerminalSubclassProc)));

    auto style = GetWindowLongPtrW(g_terminalHwnd, GWL_STYLE);
    style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE;
    SetWindowLongPtrW(g_terminalHwnd, GWL_STYLE, style);

    g_exports.TerminalRegisterWriteCallback(g_terminal, TerminalWriteCallback);
    ApplyTheme();
    RefreshBounds();
    SendIntroText();
    SetTimer(g_terminalHwnd, 1, 33, nullptr);
    StartHubBridge();
    if (const auto controlThread = CreateThread(nullptr, 0, ControlPipeThread, nullptr, 0, nullptr))
    {
        CloseHandle(controlThread);
    }

    Log(L"CreateDirectTerminal.end ok");
    return true;
}

static void DestroyDirectTerminal()
{
    Log(L"DestroyDirectTerminal.begin");
    StopHubBridge();

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
    Log(L"DestroyDirectTerminal.end");
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int)
{
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    g_options = ParseOptions();
    InitializeLogPath();
    LogFormat(
        L"wWinMain.start pid=%lu parent=%s topOffset=%d columnIndex=%d columnCount=%d columnGap=%d endpoint=%s session=%s command=%s",
        GetCurrentProcessId(),
        HwndToString(g_options.parentHwnd).c_str(),
        g_options.topOffset,
        g_options.columnIndex,
        g_options.columnCount,
        g_options.columnGap,
        g_options.endpoint.c_str(),
        g_options.sessionId.c_str(),
        g_options.command.c_str());

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

    Log(L"wWinMain.messageLoop.exit");
    DestroyDirectTerminal();
    CoUninitialize();
    return 0;
}
