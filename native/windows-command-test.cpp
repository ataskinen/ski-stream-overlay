// SPDX-License-Identifier: GPL-2.0-or-later
#include "windows-command.hpp"
#include <iostream>

int main()
{
	using ski_platform::quoteWindowsArgument;
	if (quoteWindowsArgument(L"") != L"\"\"" ||
		quoteWindowsArgument(L"C:\\Program Files\\Node\\node.exe") != L"\"C:\\Program Files\\Node\\node.exe\"" ||
		quoteWindowsArgument(L"C:\\Test Data\\ÄÖ\\data\\") != L"\"C:\\Test Data\\ÄÖ\\data\\\\\"" ||
		quoteWindowsArgument(L"name\"quoted") != L"\"name\\\"quoted\"" ||
		quoteWindowsArgument(L"a\\\"b") != L"\"a\\\\\\\"b\"") {
		std::cerr << "Windows argument quoting failed.\n";
		return 1;
	}
	std::cout << "Windows argument quoting: empty, spaces, UTF-16 names, trailing slash and quote escapes passed.\n";
}
