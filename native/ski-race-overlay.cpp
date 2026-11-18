// SPDX-License-Identifier: GPL-2.0-or-later
#include "platform.hpp"
#include <obs-module.h>
#include <atomic>
#include <mutex>

OBS_DECLARE_MODULE()
MODULE_EXPORT const char *obs_module_description(void)
{
	return "Ski race timing sources, category results and local race control.";
}

namespace {
constexpr auto serviceUrl = "http://127.0.0.1:8787";
std::atomic<bool> stopping{false};
std::atomic<bool> ready{false};
std::thread serviceThread;
ski_platform::ChildProcess ownedProcess;

std::string resource(const char *path)
{
	char *value = obs_module_file(path);
	std::string result = value ? value : "";
	bfree(value);
	return result;
}

// An occupied port is never treated as permission to replace its process.
using ski_platform::Probe;
using ski_platform::probe;

void runService()
{
	try {
		auto existing = probe();
		if (existing == Probe::ours) {
			ready = true;
			blog(LOG_INFO, "[SkiRaceOverlay] Reusing existing local service.");
			return;
		}
		if (existing == Probe::other) {
			blog(LOG_ERROR, "[SkiRaceOverlay] Port 8787 belongs to another service; refusing to start.");
			return;
		}
		auto directory = ski_platform::dataDirectory();
		std::filesystem::create_directories(directory);
#ifdef _WIN32
		std::string node = resource("runtime/node.exe");
#else
		std::string node = resource("runtime/node");
#endif
		std::string script = resource("app/server.mjs");
		if (node.empty() || script.empty()) {
			blog(LOG_ERROR, "[SkiRaceOverlay] Bundled runtime or service is missing; rebuild the complete plugin.");
			return;
		}
		unsigned long error = 0;
		if (!ski_platform::launch(ownedProcess, node, script, directory, error)) {
			blog(LOG_ERROR, "[SkiRaceOverlay] Could not start bundled service (%lu).", error);
			return;
		}
		for (int attempt = 0; attempt < 40 && !stopping; ++attempt) {
			if (probe() == Probe::ours) {
				ready = true;
				blog(LOG_INFO, "[SkiRaceOverlay] Local race control ready at %s", serviceUrl);
				return;
			}
			if (ski_platform::childExited(ownedProcess)) {
				blog(LOG_ERROR, "[SkiRaceOverlay] Service exited; see service.log in the per-user ski-stream-overlay data folder.");
				return;
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(150));
		}
	} catch (const std::exception &error) {
		blog(LOG_ERROR, "[SkiRaceOverlay] Service setup failed: %s", error.what());
	}
}

std::string urlEncode(const std::string &input)
{
	constexpr char hex[] = "0123456789ABCDEF";
	std::string output;
	for (unsigned char ch : input) {
		if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~') output += ch;
		else { output += '%'; output += hex[ch >> 4]; output += hex[ch & 15]; }
	}
	return output;
}

struct Overlay {
	obs_source_t *source;
	std::atomic<obs_source_t *> browser{nullptr};
	std::mutex settingsMutex;
	std::atomic<bool> dirty{true};
	std::atomic<bool> pending{false};
	std::string url;
};

void update(void *data, obs_data_t *settings)
{
	auto *overlay = static_cast<Overlay *>(data);
	std::lock_guard<std::mutex> lock(overlay->settingsMutex);
	std::string view = obs_data_get_string(settings, "view");
	if (view != "top10" && view != "auto") view = "current";
	overlay->url = std::string(serviceUrl) + "/overlay/" + view + "?category=" +
		urlEncode(obs_data_get_string(settings, "category"));
	overlay->dirty = true;
}

void updateBrowserOnUi(void *data)
{
	auto *overlay = static_cast<Overlay *>(data);
	std::string url;
	{
		std::lock_guard<std::mutex> lock(overlay->settingsMutex);
		url = overlay->url;
	}
	obs_data_t *settings = obs_data_create();
	obs_data_set_string(settings, "url", url.c_str());
	obs_data_set_int(settings, "width", 1920);
	obs_data_set_int(settings, "height", 1080);
	obs_data_set_int(settings, "fps", 30);
	obs_data_set_bool(settings, "is_local_file", false);
	obs_data_set_bool(settings, "shutdown", false);
	obs_data_set_string(settings, "css", "body { background: transparent; margin: 0; overflow: hidden; }");
	auto *browser = overlay->browser.load();
	if (!browser) {
		// CEF must initialize on the UI thread. Never hold a lock across this call:
		// OBS's UI/audio tree enumeration must continue while CEF starts.
		browser = obs_source_create_private("browser_source", "Ski Race Overlay renderer", settings);
		overlay->browser = browser;
		if (browser) obs_source_add_active_child(overlay->source, browser);
		else blog(LOG_ERROR, "[SkiRaceOverlay] OBS Browser Source is unavailable. Enable OBS's bundled browser plugin.");
	} else obs_source_update(browser, settings);
	obs_data_release(settings);
	overlay->pending = false;
	// tick retained the parent, so destroy cannot run until the UI task finishes.
	obs_source_release(overlay->source);
}

void tick(void *data, float)
{
	auto *overlay = static_cast<Overlay *>(data);
	if (!ready || !overlay->dirty || overlay->pending.exchange(true)) return;
	overlay->dirty = false;
	obs_source_get_ref(overlay->source);
	obs_queue_task(OBS_TASK_UI, updateBrowserOnUi, overlay, false);
}

void *create(obs_data_t *settings, obs_source_t *source)
{
	auto *overlay = new Overlay;
	overlay->source = source;
	update(overlay, settings);
	return overlay;
}

void destroy(void *data)
{
	auto *overlay = static_cast<Overlay *>(data);
	if (auto *browser = overlay->browser.load()) {
		obs_source_remove_active_child(overlay->source, browser);
		obs_source_release(browser);
	}
	delete overlay;
}

void render(void *data, gs_effect_t *)
{
	auto *overlay = static_cast<Overlay *>(data);
	if (auto *browser = overlay->browser.load()) obs_source_video_render(browser);
}

void enumerate(void *data, obs_source_enum_proc_t callback, void *param)
{
	auto *overlay = static_cast<Overlay *>(data);
	if (auto *browser = overlay->browser.load()) callback(overlay->source, browser, param);
}

bool openControl(obs_properties_t *, obs_property_t *, void *)
{
	ski_platform::openControl(serviceUrl);
	return false;
}

obs_properties_t *properties(void *)
{
	obs_properties_t *props = obs_properties_create();
	obs_property_t *view = obs_properties_add_list(props, "view", "Display", OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_STRING);
	obs_property_list_add_string(view, "Automatic race coverage", "auto");
	obs_property_list_add_string(view, "Racers on course", "current");
	obs_property_list_add_string(view, "Category top 10", "top10");
	obs_property_t *category = obs_properties_add_text(props, "category", "Category (exact CSV value)", OBS_TEXT_DEFAULT);
	obs_property_set_long_description(category, "Used by manual top 10 only. Leave blank for the first category, or enter auto to follow the current racer. Automatic race coverage selects categories itself.");
	obs_properties_add_button2(props, "control", "Open race control — connection, CSV and demo", openControl, nullptr);
	return props;
}
} // namespace

bool obs_module_load(void)
{
	obs_source_info info{};
	info.id = "ski_race_overlay";
	info.type = OBS_SOURCE_TYPE_INPUT;
	info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_COMPOSITE;
	info.get_name = [](void *) { return "Ski Race Overlay"; };
	info.create = create;
	info.destroy = destroy;
	info.update = update;
	info.get_width = [](void *) -> uint32_t { return 1920; };
	info.get_height = [](void *) -> uint32_t { return 1080; };
	info.get_defaults = [](obs_data_t *settings) { obs_data_set_default_string(settings, "view", "auto"); };
	info.get_properties = properties;
	info.video_tick = tick;
	info.video_render = render;
	info.enum_active_sources = enumerate;
	info.enum_all_sources = enumerate;
	// The overlay is intentionally silent; camera and announcement audio remain independent OBS sources.
	info.audio_render = [](void *, uint64_t *, obs_source_audio_mix *, uint32_t, size_t, size_t) { return false; };
	obs_register_source(&info);
	serviceThread = std::thread(runService);
	blog(LOG_INFO, "[SkiRaceOverlay] Registered native overlay source (OBS 33.0.1).");
	return true;
}

void obs_module_unload(void)
{
	stopping = true;
	if (serviceThread.joinable()) serviceThread.join();
	ready = false;
	ski_platform::stopChild(ownedProcess);
}
