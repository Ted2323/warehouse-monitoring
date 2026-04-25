@echo off
echo Creating virtual environment...
python -m venv .venv

echo Activating and installing dependencies...
call .venv\Scripts\activate.bat
pip install -r requirements.txt

echo.
echo Done! Run the server with: run.bat
pause
