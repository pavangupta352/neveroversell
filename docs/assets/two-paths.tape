# Recorded with vhs: vhs docs/assets/two-paths.tape
# Runs the example simulator: the browser return and the provider webhook racing to confirm one hold.

Output docs/assets/two-paths.gif

Set Shell "zsh"
Set FontSize 14
Set FontFamily "Menlo"
Set Width 1280
Set Height 520
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful
Set BorderRadius 10

Env DATABASE_URL "postgres://nos:nos@127.0.0.1:54329/nos"
Hide
Type "cd examples/two-paths-express && clear" Enter
Show

Type "npx tsx simulate.ts"
Sleep 600ms
Enter
Sleep 7000ms
