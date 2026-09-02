# Recorded with vhs (https://github.com/charmbracelet/vhs): vhs docs/assets/bench.tape
# Requires the package linked on PATH (npm link) and Postgres from docker compose.

Output docs/assets/bench.gif

Set Shell "zsh"
Set FontSize 16
Set FontFamily "Menlo"
Set Width 1280
Set Height 250
Set Padding 28
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful
Set BorderRadius 10

Env DATABASE_URL "postgres://nos:nos@127.0.0.1:54329/nos"
Hide
Type "clear" Enter
Show

Type "neveroversell bench --units 10 --buyers 500"
Sleep 600ms
Enter
Sleep 2500ms

Type "neveroversell bench --units 10 --buyers 500 --naive"
Sleep 600ms
Enter
Sleep 4000ms
