#ifndef MyAppVersion
  #define MyAppVersion "1.1.0"
#endif

[Setup]
AppId={{8D6B5F2E-7F1A-4E8B-9D31-52B8A901C4E7}
AppName=Wimotek Edge CDP Node
AppVersion={#MyAppVersion}
AppPublisher=Wimotek
DefaultDirName={autopf}\WimotekEdgeNode
DefaultGroupName=Wimotek Edge CDP Node
AllowNoIcons=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\release_assets
OutputBaseFilename=WimotekEdgeNode-Setup-win64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\release_stage\WimotekEdgeNode\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Wimotek Edge CDP Node"; Filename: "{app}\WimotekEdgeNode.exe"
Name: "{group}\{cm:UninstallProgram,Wimotek Edge CDP Node}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Wimotek Edge CDP Node"; Filename: "{app}\WimotekEdgeNode.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\WimotekEdgeNode.exe"; Description: "{cm:LaunchProgram,Wimotek Edge CDP Node}"; Flags: nowait postinstall skipifsilent
