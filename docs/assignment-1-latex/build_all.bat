@echo off
cd /d "%~dp0"
if not exist pdf mkdir pdf
for %%F in (??_*.tex) do (
    echo Compiling %%F
    xelatex -interaction=nonstopmode -halt-on-error -output-directory=pdf "%%F" || exit /b 1
    xelatex -interaction=nonstopmode -halt-on-error -output-directory=pdf "%%F" || exit /b 1
)
echo All reports compiled in pdf folder.
