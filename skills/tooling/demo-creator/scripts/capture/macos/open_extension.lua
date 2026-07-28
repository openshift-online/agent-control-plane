local module = {}
local chrome_for_testing_bundle_id = "com.google.chrome.for.testing"

local function read_config(config_path)
  local file, open_error = io.open(config_path, "r")
  if not file then error("cannot open capture control file: " .. tostring(open_error)) end
  local contents = file:read("*a")
  file:close()
  return hs.json.decode(contents)
end

local function string_attribute(element, attribute)
  local ok, value = pcall(function() return element:attributeValue(attribute) end)
  if ok and type(value) == "string" then return value end
  return nil
end

local function children_for(element)
  local ok, children = pcall(function() return element:attributeValue("AXChildren") end)
  if ok and type(children) == "table" then return children end
  return {}
end

local function descendants(root, maximum)
  local result = {}
  local pending = {root}
  while #pending > 0 and #result < maximum do
    local element = table.remove(pending, 1)
    table.insert(result, element)
    for _, child in ipairs(children_for(element)) do table.insert(pending, child) end
  end
  return result
end

local function action_names(element)
  local ok, actions = pcall(function() return element:actionNames() end)
  if ok and type(actions) == "table" then return actions end
  return {}
end

local function supports_action(element, expected)
  for _, action in ipairs(action_names(element)) do
    if action == expected then return true end
  end
  return false
end

local function element_frame(element)
  local ok, frame = pcall(function() return element:attributeValue("AXFrame") end)
  if not ok or type(frame) ~= "table" then return nil end
  local width = frame.w or frame.width
  local height = frame.h or frame.height
  if not frame.x or not frame.y or not width or not height then return nil end
  return {x = frame.x, y = frame.y, width = width, height = height}
end

local function browser_window(app)
  local window = app:focusedWindow() or app:mainWindow()
  if not window then error("Chrome for Testing has no focused window") end
  return window
end

local function append_pointer(output_path, event_type, point, window_frame)
  local normalized_x = math.max(0, math.min(1, (point.x - window_frame.x) / window_frame.w))
  local normalized_y = math.max(0, math.min(1, (point.y - window_frame.y) / window_frame.h))
  local event = {
    type = event_type,
    monotonicSeconds = hs.timer.absoluteTime() / 1000000000,
    x = normalized_x,
    y = normalized_y,
  }
  local file, open_error = io.open(output_path, "a")
  if not file then error("cannot write pointer events: " .. tostring(open_error)) end
  file:write(hs.json.encode(event), "\n")
  file:close()
end

local function is_exact_extension_control(element, config)
  local description = string_attribute(element, "AXDescription")
  if description == config.extensionName or description == config.extensionId then return true end
  for _, attribute in ipairs({"AXTitle", "AXHelp", "AXValue"}) do
    local value = string_attribute(element, attribute)
    if value == config.extensionId then return true end
  end
  return false
end

local function toolbar_frame(element, window)
  local frame = element_frame(element)
  if not frame then return nil end
  local window_frame = window:frame()
  if window_frame.w <= 0 or window_frame.h <= 0 then return nil end
  local center_x = frame.x + frame.width / 2
  local center_y = frame.y + frame.height / 2
  local normalized_center_x = (center_x - window_frame.x) / window_frame.w
  local normalized_center_y = (center_y - window_frame.y) / window_frame.h
  if frame.width <= 0 or frame.height <= 0 or frame.width > 64 or frame.height > 64 then return nil end
  if frame.x < window_frame.x or frame.y < window_frame.y or
      frame.x + frame.width > window_frame.x + window_frame.w or
      frame.y + frame.height > window_frame.y + window_frame.h then return nil end
  if normalized_center_x < 0 or normalized_center_x > 1 then return nil end
  if normalized_center_y < 0 or normalized_center_y >= 0.1 then return nil end
  return {frame = frame, center = {x = center_x, y = center_y}}
end

local function verified_toolbar_candidates(application_element, config, window)
  local candidates = {}
  for _, element in ipairs(descendants(application_element, 5000)) do
    if string_attribute(element, "AXRole") == "AXPopUpButton" and
        supports_action(element, "AXPress") and is_exact_extension_control(element, config) then
      local geometry = toolbar_frame(element, window)
      if geometry then
        table.insert(candidates, {element = element, geometry = geometry})
      end
    end
  end
  return candidates
end

local function start_pointer_capture(config)
  if _G.acpDemoCreatorPointerPid and _G.acpDemoCreatorPointerPid ~= config.applicationPid then
    error("pointer capture is owned by a different Chrome process")
  end
  _G.acpDemoCreatorPointerPid = config.applicationPid
end

local function stop_pointer_capture(application_pid)
  if _G.acpDemoCreatorPointerPid and _G.acpDemoCreatorPointerPid ~= application_pid then
    error("refusing to stop pointer capture owned by a different Chrome process")
  end
  _G.acpDemoCreatorPointerPid = nil
end

local function application_bundle_id(app)
  if not app then return nil end
  local ok, bundle_id = pcall(function() return app:bundleID() end)
  if ok then return bundle_id end
  return nil
end

local function record_matching_applications(state)
  for _, app in ipairs(hs.application.applicationsForBundleID(state.bundleId)) do
    local pid = app:pid()
    if pid and pid ~= state.expectedPid then state.otherPids[pid] = true end
  end
end

local function watcher_result(state, stopped)
  local other_pids = {}
  for pid in pairs(state.otherPids) do table.insert(other_pids, pid) end
  table.sort(other_pids)
  return {
    expectedPid = state.expectedPid,
    expectedTerminated = state.expectedTerminated,
    otherPids = other_pids,
    stopped = stopped,
  }
end

local function start_application_watcher(config)
  if _G.acpDemoCreatorApplicationWatcher then
    error("application watcher is already active")
  end
  local expected = hs.application.get(config.applicationPid)
  if not expected or application_bundle_id(expected) ~= chrome_for_testing_bundle_id then
    error("cannot start watcher without the launched Chrome for Testing process")
  end
  local state = {
    bundleId = chrome_for_testing_bundle_id,
    expectedPid = config.applicationPid,
    expectedTerminated = false,
    otherPids = {},
  }
  local watcher = hs.application.watcher.new(function(_, event, app)
    local pid = app and app:pid() or nil
    if event == hs.application.watcher.terminated and pid == state.expectedPid then
      state.expectedTerminated = true
    elseif pid and pid ~= state.expectedPid and application_bundle_id(app) == state.bundleId then
      state.otherPids[pid] = true
    end
    record_matching_applications(state)
  end)
  _G.acpDemoCreatorApplicationWatcherState = state
  _G.acpDemoCreatorApplicationWatcher = watcher
  watcher:start()
  record_matching_applications(state)
  return watcher_result(state, false)
end

local function stop_application_watcher(application_pid)
  local watcher = _G.acpDemoCreatorApplicationWatcher
  local state = _G.acpDemoCreatorApplicationWatcherState
  if not watcher or not state then error("application watcher is not active") end
  if state.expectedPid ~= application_pid then
    error("refusing to stop application watcher owned by a different Chrome process")
  end
  local expected = hs.application.get(state.expectedPid)
  if not expected or application_bundle_id(expected) ~= state.bundleId then
    state.expectedTerminated = true
  end
  record_matching_applications(state)
  watcher:stop()
  _G.acpDemoCreatorApplicationWatcher = nil
  _G.acpDemoCreatorApplicationWatcherState = nil
  return watcher_result(state, true)
end

local function open_extension(config, app, window)
  if type(config.extensionName) ~= "string" or config.extensionName == "" or
      type(config.extensionId) ~= "string" or config.extensionId == "" then
    error("verified extension name and ID are required for the toolbar action")
  end
  app:activate(true)
  hs.timer.usleep(300000)
  local application_element = hs.axuielement.applicationElement(app)
  local candidates = verified_toolbar_candidates(application_element, config, window)
  if #candidates == 0 then
    error("preseeded extension toolbar action is absent from Chrome Accessibility")
  end
  if #candidates > 1 then
    error("preseeded extension toolbar action is ambiguous in Chrome Accessibility")
  end

  local candidate = candidates[1]
  hs.mouse.absolutePosition(candidate.geometry.center)
  append_pointer(config.pointerOutput, "click", candidate.geometry.center, window:frame())
  local press_call_succeeded, press_result, press_error = pcall(function()
    return candidate.element:performAction("AXPress")
  end)
  if not press_call_succeeded then
    error("extension toolbar AXPress failed: " .. tostring(press_result))
  end
  if not press_result then error("extension toolbar AXPress failed: " .. tostring(press_error)) end
  return {windowId = window:id(), pressed = true, pinned = true, preseeded = true}
end

function module.run(config_path)
  local config = read_config(config_path)
  if type(config.applicationPid) ~= "number" or config.applicationPid <= 0 or
      config.applicationPid ~= math.floor(config.applicationPid) then
    error("capture control requires a positive integer applicationPid")
  end
  if config.action == "stop-pointer" then
    stop_pointer_capture(config.applicationPid)
    return {stopped = true}
  end
  if config.action == "start-application-watcher" then
    return start_application_watcher(config)
  end
  if config.action == "stop-application-watcher" then
    return stop_application_watcher(config.applicationPid)
  end

  local app = hs.application.get(config.applicationPid)
  if not app then error("the launched Chrome for Testing process is not running") end
  if app:bundleID() ~= chrome_for_testing_bundle_id then
    error("the launched PID is not Chrome for Testing")
  end
  local window = browser_window(app)
  if config.action == "start-pointer" then
    start_pointer_capture(config)
    return {
      started = true,
      windowId = window:id(),
      monotonicSeconds = hs.timer.absoluteTime() / 1000000000,
    }
  end
  if config.action == "open" then return open_extension(config, app, window) end
  error("unknown capture action")
end

return module
