Option Explicit

Dim shell, command
Set shell = CreateObject("WScript.Shell")

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\chatbot-qq\scripts\run-opentoken-minimum-monitor.ps1"""
shell.Run command, 0, True
