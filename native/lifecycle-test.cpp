// SPDX-License-Identifier: GPL-2.0-or-later
// Run against libobs data/settings, with source/scheduler boundaries mocked.
#include "ski-race-overlay.cpp"
#include <cassert>
#include <future>
#include <iostream>

namespace {
int parentToken, browserToken;
auto *parent = reinterpret_cast<obs_source_t *>(&parentToken);
auto *child = reinterpret_cast<obs_source_t *>(&browserToken);
obs_task_t queuedTask = nullptr;
void *queuedParam = nullptr;
bool onUi = false;
int queued = 0, created = 0, updated = 0, parentRefs = 0, childRefs = 0, rendered = 0;
Overlay *underTest;
std::string lastUrl;
}

extern "C" {
void obs_queue_task(enum obs_task_type type, obs_task_t task, void *param, bool wait)
{
	assert(type == OBS_TASK_UI && !wait);
	assert(!queuedTask);
	queuedTask = task;
	queuedParam = param;
	++queued;
}
obs_source_t *obs_source_get_ref(obs_source_t *source)
{
	assert(source == parent);
	++parentRefs;
	return source;
}
void obs_source_release(obs_source_t *source)
{
	if (source == parent) --parentRefs;
	else { assert(source == child); --childRefs; }
}
obs_source_t *obs_source_create_private(const char *, const char *, obs_data_t *settings)
{
	assert(onUi); // Creating CEF from video_tick caused the original OBS hang.
	lastUrl = obs_data_get_string(settings, "url");
	// Simulate CEF initialization needing tree enumeration on a different thread.
	// The old implementation deadlocked here by holding its source mutex.
	auto enumeration = std::async(std::launch::async, [] {
		enumerate(underTest, [](obs_source_t *, obs_source_t *, void *) {}, nullptr);
	});
	assert(enumeration.wait_for(std::chrono::seconds(1)) == std::future_status::ready);
	enumeration.get();
	++created;
	++childRefs;
	return child;
}
bool obs_source_add_active_child(obs_source_t *source, obs_source_t *browser)
{
	assert(source == parent && browser == child && onUi);
	return true;
}
void obs_source_remove_active_child(obs_source_t *source, obs_source_t *browser)
{
	assert(source == parent && browser == child);
}
void obs_source_update(obs_source_t *source, obs_data_t *settings)
{
	assert(onUi && source == child);
	lastUrl = obs_data_get_string(settings, "url");
	++updated;
}
void obs_source_video_render(obs_source_t *source)
{
	assert(source == child);
	++rendered;
}
}

void runUiTask()
{
	assert(queuedTask && !onUi);
	auto task = queuedTask;
	queuedTask = nullptr;
	onUi = true;
	task(queuedParam);
	onUi = false;
}

int main()
{
	obs_data_t *settings = obs_data_create();
	obs_data_set_string(settings, "view", "current");
	auto *overlay = static_cast<Overlay *>(create(settings, parent));
	underTest = overlay;
	ready = true;
	tick(overlay, 0);
	tick(overlay, 0);
	assert(created == 0 && queued == 1 && parentRefs == 1);
	runUiTask();
	assert(created == 1 && parentRefs == 0 && childRefs == 1);
	assert(lastUrl == "http://127.0.0.1:8787/overlay/current?category=");
	obs_data_set_string(settings, "view", "top10");
	obs_data_set_string(settings, "category", "U12 tytöt");
	update(overlay, settings);
	tick(overlay, 0);
	assert(updated == 0 && parentRefs == 1);
	runUiTask();
	assert(created == 1 && updated == 1 && parentRefs == 0);
	assert(lastUrl.find("category=U12%20tyt%C3%B6t") != std::string::npos);
	render(overlay, nullptr);
	assert(rendered == 1);
	destroy(overlay);
	assert(childRefs == 0);
	obs_data_release(settings);
	std::cout << "Native lifecycle: UI queue, nonblocking enumeration, updates, references and UTF-8 category passed.\n";
}
