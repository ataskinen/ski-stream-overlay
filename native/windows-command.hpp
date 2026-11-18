// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <string>

namespace ski_platform {
// Windows CRT argv parsing: backslashes are doubled before quotes and the closing quote.
inline std::wstring quoteWindowsArgument(const std::wstring &argument)
{
	std::wstring result = L"\"";
	size_t backslashes = 0;
	for (wchar_t value : argument) {
		if (value == L'\\') { ++backslashes; continue; }
		if (value == L'\"') result.append(backslashes * 2 + 1, L'\\');
		else result.append(backslashes, L'\\');
		backslashes = 0;
		result += value;
	}
	result.append(backslashes * 2, L'\\');
	result += L'\"';
	return result;
}
} // namespace ski_platform
