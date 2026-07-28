on run arguments
  if (count of arguments) is not 1 then error "expected one Lua source argument"
  tell application "Hammerspoon"
    execute lua code (item 1 of arguments)
  end tell
end run
