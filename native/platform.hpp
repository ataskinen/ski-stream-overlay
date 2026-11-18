// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <string>
#include <stdexcept>
#include <thread>
#include <vector>
#include "windows-command.hpp"

namespace ski_platform {
enum class Probe { unavailable, ours, other };
#ifdef _WIN32
using Socket = SOCKET;
constexpr Socket invalidSocket = INVALID_SOCKET;
inline int socketError() { return WSAGetLastError(); }
inline bool refused(int error) { return error == WSAECONNREFUSED; }
inline bool wouldBlock(int error) { return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS; }
inline void closeSocket(Socket fd) { closesocket(fd); }
inline bool waitSocket(Socket fd, bool write, int timeoutMs)
{
	fd_set set; FD_ZERO(&set); FD_SET(fd, &set);
	fd_set errors = set;
	timeval timeout{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
	return select(0, write ? nullptr : &set, write ? &set : nullptr, &errors, &timeout) > 0;
}
struct SocketRuntime {
	bool valid;
	SocketRuntime() { WSADATA data{}; valid = WSAStartup(MAKEWORD(2, 2), &data) == 0; }
	~SocketRuntime() { if (valid) WSACleanup(); }
};
#else
using Socket = int;
constexpr Socket invalidSocket = -1;
inline int socketError() { return errno; }
inline bool refused(int error) { return error == ECONNREFUSED; }
inline bool wouldBlock(int error) { return error == EWOULDBLOCK || error == EAGAIN || error == EINPROGRESS; }
inline void closeSocket(Socket fd) { close(fd); }
inline bool waitSocket(Socket fd, bool write, int timeoutMs)
{
	pollfd item{fd, static_cast<short>(write ? POLLOUT : POLLIN), 0};
	return poll(&item, 1, timeoutMs) > 0;
}
struct SocketRuntime { bool valid = true; };
#endif

inline Probe probe()
{
	SocketRuntime runtime;
	if (!runtime.valid) return Probe::other;
	Socket fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd == invalidSocket) return Probe::other;
#ifdef _WIN32
	u_long nonblocking = 1;
	if (ioctlsocket(fd, FIONBIO, &nonblocking)) { closeSocket(fd); return Probe::other; }
#else
	int noSigpipe = 1;
	setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, sizeof(noSigpipe));
	if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0) { closeSocket(fd); return Probe::other; }
#endif
	sockaddr_in address{};
	address.sin_family = AF_INET; address.sin_port = htons(8787);
	inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
	if (connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) < 0) {
		int error = socketError();
		if (!wouldBlock(error)) { closeSocket(fd); return refused(error) ? Probe::unavailable : Probe::other; }
	}
	int error = 0;
#ifdef _WIN32
	int size = sizeof(error);
	const bool failed = !waitSocket(fd, true, 300) || getsockopt(fd, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&error), &size) || error;
#else
	socklen_t size = sizeof(error);
	const bool failed = !waitSocket(fd, true, 300) || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) || error;
#endif
	if (failed) { closeSocket(fd); return refused(error) ? Probe::unavailable : Probe::other; }
	const std::string request = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n";
	const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(1200);
	size_t sent = 0;
	while (sent < request.size() && std::chrono::steady_clock::now() < deadline) {
		if (!waitSocket(fd, true, 100)) continue;
		auto count = send(fd, request.data() + sent, static_cast<int>(request.size() - sent), 0);
		if (count > 0) sent += static_cast<size_t>(count);
		else if (count == 0 || !wouldBlock(socketError())) break;
	}
	std::string response;
	while (sent == request.size() && response.size() < 4096 && std::chrono::steady_clock::now() < deadline) {
		if (!waitSocket(fd, false, 100)) continue;
		char buffer[1024];
		auto count = recv(fd, buffer, sizeof(buffer), 0);
		if (count > 0) response.append(buffer, static_cast<size_t>(count));
		else if (count == 0 || !wouldBlock(socketError())) break;
	}
	closeSocket(fd);
	return response.find("200 OK") != std::string::npos && response.find("\"app\":\"ski-stream-overlay\"") != std::string::npos ? Probe::ours : Probe::other;
}

#ifdef _WIN32
struct ChildProcess { HANDLE process = nullptr; HANDLE input = nullptr; };
inline std::wstring wide(const std::string &text)
{
	if (text.empty()) return {};
	int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
	if (!count) throw std::runtime_error("Invalid UTF-8 resource path");
	std::wstring result(static_cast<size_t>(count), L'\0');
	MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count);
	return result;
}
inline std::filesystem::path dataDirectory()
{
	DWORD count = GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
	if (!count) throw std::runtime_error("LOCALAPPDATA is unavailable");
	std::wstring base(count, L'\0');
	DWORD copied = GetEnvironmentVariableW(L"LOCALAPPDATA", base.data(), count);
	if (!copied || copied >= count) throw std::runtime_error("Could not read LOCALAPPDATA");
	base.resize(copied);
	return std::filesystem::path(base) / L"ski-stream-overlay";
}
inline bool launch(ChildProcess &child, const std::string &node, const std::string &script, const std::filesystem::path &directory, unsigned long &error)
{
	std::wstring executable = wide(node);
	std::wstring command = quoteWindowsArgument(executable) + L" " + quoteWindowsArgument(wide(script));
	std::vector<std::wstring> environment;
	wchar_t *block = GetEnvironmentStringsW();
	if (!block) { error = GetLastError(); return false; }
	for (const wchar_t *entry = block; *entry; entry += wcslen(entry) + 1) {
		std::wstring item(entry);
		auto equal = item.find(L'=', item[0] == L'=' ? 1 : 0);
		std::wstring key = item.substr(0, equal);
		if (_wcsicmp(key.c_str(), L"DATA_DIR") && _wcsicmp(key.c_str(), L"PORT") && _wcsicmp(key.c_str(), L"HOST") && _wcsicmp(key.c_str(), L"SKI_PARENT_CONTROL")) environment.push_back(item);
	}
	FreeEnvironmentStringsW(block);
	environment.push_back(L"DATA_DIR=" + directory.wstring());
	environment.emplace_back(L"PORT=8787"); environment.emplace_back(L"HOST=127.0.0.1"); environment.emplace_back(L"SKI_PARENT_CONTROL=1");
	std::sort(environment.begin(), environment.end(), [](const auto &a, const auto &b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
	std::vector<wchar_t> env;
	for (const auto &item : environment) { env.insert(env.end(), item.begin(), item.end()); env.push_back(L'\0'); }
	env.push_back(L'\0');
	SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
	HANDLE input = nullptr, writer = nullptr;
	if (!CreatePipe(&input, &writer, &security, 0)) { error = GetLastError(); return false; }
	if (!SetHandleInformation(writer, HANDLE_FLAG_INHERIT, 0)) { error = GetLastError(); CloseHandle(input); CloseHandle(writer); return false; }
	HANDLE log = CreateFileW((directory / L"service.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (log == INVALID_HANDLE_VALUE) { error = GetLastError(); CloseHandle(input); CloseHandle(writer); return false; }
	SIZE_T bytes = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
	std::vector<unsigned char> attributes(bytes);
	STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
	startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	startup.StartupInfo.hStdInput = input; startup.StartupInfo.hStdOutput = log; startup.StartupInfo.hStdError = log;
	startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
	HANDLE handles[] = {input, log};
	bool initialized = InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes) != FALSE;
	bool configured = initialized && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr) != FALSE;
	PROCESS_INFORMATION process{};
	BOOL created = configured && CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env.data(), directory.c_str(), &startup.StartupInfo, &process);
	if (!created) error = GetLastError();
	if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
	CloseHandle(input); CloseHandle(log);
	if (!created) { CloseHandle(writer); return false; }
	CloseHandle(process.hThread); child.process = process.hProcess; child.input = writer;
	return true;
}
inline bool childExited(ChildProcess &child)
{
	if (!child.process) return true;
	if (WaitForSingleObject(child.process, 0) != WAIT_OBJECT_0) return false;
	CloseHandle(child.process); child.process = nullptr;
	if (child.input) { CloseHandle(child.input); child.input = nullptr; }
	return true;
}
inline void stopChild(ChildProcess &child)
{
	if (!child.process) return;
	if (!childExited(child)) {
		DWORD written = 0;
		if (child.input) WriteFile(child.input, "shutdown\n", 9, &written, nullptr);
		if (WaitForSingleObject(child.process, 2500) == WAIT_TIMEOUT) {
			// Only the retained handle from our CreateProcess is eligible for termination.
			TerminateProcess(child.process, 1); WaitForSingleObject(child.process, 1000);
		}
		CloseHandle(child.process); child.process = nullptr;
		if (child.input) { CloseHandle(child.input); child.input = nullptr; }
	}
}
inline void openControl(const char *url) { ShellExecuteW(nullptr, L"open", wide(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL); }
#else
struct ChildProcess { pid_t pid = -1; };
inline std::filesystem::path dataDirectory()
{
	const char *home = getenv("HOME");
	if (!home) throw std::runtime_error("HOME is unavailable");
	return std::filesystem::path(home) / "Library/Application Support/ski-stream-overlay";
}
inline bool launch(ChildProcess &child, const std::string &node, const std::string &script, const std::filesystem::path &directory, unsigned long &error)
{
	std::vector<std::string> environment;
	for (char **value = environ; *value; ++value) {
		std::string entry(*value);
		if (entry.rfind("DATA_DIR=", 0) && entry.rfind("PORT=", 0) && entry.rfind("HOST=", 0) && entry.rfind("SKI_PARENT_CONTROL=", 0)) environment.push_back(entry);
	}
	environment.push_back("DATA_DIR=" + directory.string()); environment.emplace_back("PORT=8787"); environment.emplace_back("HOST=127.0.0.1");
	std::vector<char *> env;
	for (auto &entry : environment) env.push_back(entry.data());
	env.push_back(nullptr);
	char *args[] = {const_cast<char *>(node.c_str()), const_cast<char *>(script.c_str()), nullptr};
	posix_spawn_file_actions_t actions;
	posix_spawn_file_actions_init(&actions);
	posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
	std::string log = (directory / "service.log").string();
	posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, log.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0600);
	posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDERR_FILENO);
	error = static_cast<unsigned long>(posix_spawn(&child.pid, node.c_str(), &actions, nullptr, args, env.data()));
	posix_spawn_file_actions_destroy(&actions);
	if (error) child.pid = -1;
	return !error;
}
inline bool childExited(ChildProcess &child)
{
	if (child.pid <= 0) return true;
	if (waitpid(child.pid, nullptr, WNOHANG) == child.pid) { child.pid = -1; return true; }
	return false;
}
inline void stopChild(ChildProcess &child)
{
	if (child.pid > 0 && waitpid(child.pid, nullptr, WNOHANG) == 0) {
		kill(child.pid, SIGTERM);
		for (int i = 0; i < 20; ++i) {
			if (waitpid(child.pid, nullptr, WNOHANG) != 0) { child.pid = -1; return; }
			std::this_thread::sleep_for(std::chrono::milliseconds(50));
		}
		kill(child.pid, SIGKILL); waitpid(child.pid, nullptr, 0);
	}
	child.pid = -1;
}
inline void openControl(const char *url)
{
	pid_t pid;
	const char *args[] = {"/usr/bin/open", url, nullptr};
	if (posix_spawn(&pid, args[0], nullptr, nullptr, const_cast<char **>(args), environ) == 0) std::thread([pid] { waitpid(pid, nullptr, 0); }).detach();
}
#endif
} // namespace ski_platform
