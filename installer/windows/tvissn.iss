; Compile through scripts/build-windows-installer.mjs: it verifies the ZIP and
; generates an explicit file list and post-install SHA-256 checks.
[Setup]
AppId={{B095594C-135D-446B-9CEC-7200832E6499}
AppName=tvissn Chrome extension
AppVersion={#AppVersion}
AppPublisher=tvissn
DefaultDirName={code:GetInstallDir}
PrivilegesRequired=lowest
UsePreviousAppDir=no
DisableDirPage=no
AppendDefaultDirName=no
DirExistsWarning=no
DisableProgramGroupPage=yes
Uninstallable=no
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
OutputDir={#OutputDir}
OutputBaseFilename=tvissn-extension-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Messages]
english.SelectDirDesc=Choose the permanent extension folder.
english.SelectDirLabel3=For an existing unpacked tvissn, choose its EXACT current folder (containing manifest.json). Keep the extension installed in Chrome. No browser profiles are modified.
russian.SelectDirDesc=Выберите постоянную папку расширения.
russian.SelectDirLabel3=Если tvissn уже загружен вручную, выберите ТОЧНО его прежнюю папку с manifest.json. Не удаляйте расширение из Chrome. Профили браузера не изменяются.

[Files]
; Preprocessor directive lines take expressions: inline directives are not
; expanded inside them, so the defined variable is referenced directly.
#include GeneratedDir + "\package-files.iss"

[Code]
var
  PackageVerified: Boolean;
  FinishInstructions: TNewMemo;

function GetInstallDir(Param: String): String;
begin
  if not RegQueryStringValue(HKCU, 'Software\tvissn\ExtensionInstaller', 'InstallDir', Result) then
    Result := ExpandConstant('{localappdata}\tvissn\extension');
end;

#include GeneratedDir + "\verify-files.iss"

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    { A skipped/failed write must never lead to a successful finish screen. }
    VerifyInstalledFiles;
    if not RegWriteStringValue(HKCU, 'Software\tvissn\ExtensionInstaller', 'InstallDir', ExpandConstant('{app}')) then
      RaiseException('Cannot save the installation folder.');
    PackageVerified := True;
  end;
end;

procedure InitializeWizard;
begin
  { A scrollable, selectable field keeps long custom paths fully accessible. }
  FinishInstructions := TNewMemo.Create(WizardForm);
  FinishInstructions.Parent := WizardForm.FinishedPage;
  FinishInstructions.SetBounds(WizardForm.FinishedLabel.Left,
    WizardForm.FinishedLabel.Top, WizardForm.FinishedLabel.Width,
    WizardForm.FinishedPage.ClientHeight - WizardForm.FinishedLabel.Top - ScaleY(8));
  FinishInstructions.ReadOnly := True;
  FinishInstructions.WordWrap := True;
  FinishInstructions.ScrollBars := ssVertical;
  WizardForm.FinishedLabel.Visible := False;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if not PackageVerified then
    begin
      WizardForm.FinishedHeadingLabel.Caption := 'Installation failed';
      FinishInstructions.Text := 'Extension files could not be verified. Fix the write error and run the installer again. Do not reload the extension yet.';
      Exit;
    end;
    if ActiveLanguage = 'russian' then
      FinishInstructions.Text :=
        'Файлы расширения установлены в:' + #13#10 + ExpandConstant('{app}') + #13#10#13#10 +
        'Первая установка: откройте chrome://extensions, включите режим разработчика, нажмите «Загрузить распакованное расширение» и выберите эту папку.' + #13#10#13#10 +
        'Обновление: нажмите Reload («Обновить») у tvissn на chrome://extensions. Не удаляйте расширение. При следующих обновлениях запускайте новый установщик и используйте эту же папку.'
    else
      FinishInstructions.Text :=
        'Extension files installed in:' + #13#10 + ExpandConstant('{app}') + #13#10#13#10 +
        'First install: open chrome://extensions, enable Developer mode, click Load unpacked and select this folder.' + #13#10#13#10 +
        'Update: click Reload for tvissn on chrome://extensions. Do not remove the extension. For future updates, run the new installer and use the same folder.';
  end;
end;
