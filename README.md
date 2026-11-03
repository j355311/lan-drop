# LAN Drop

LAN Drop sends files and notes directly between Windows computers on the same local network. It does not upload them to a cloud service. The receiving computer shows an approval prompt before saving each file or note.

## Use on two computers

1. Open LAN Drop on both computers and connect them to the same local network.
2. If Windows Firewall asks, allow LAN Drop on **Private networks**.
3. If Windscribe is running, turn on **Preferences → Connection → Allow LAN Traffic**.
4. Drag files into the app, choose the other computer, and select **Send files**.
5. Accept the incoming file on the receiving computer. Files save to `Downloads\LAN Drop` by default.
6. To send a note, select a computer, write in **Send a note**, and choose **Send note**. The recipient must accept it. Sent and accepted notes are saved in each computer's local LAN Drop history.
7. Use **Copy** and **Paste** in the note area, or use the standard Windows shortcuts. You can also copy files in File Explorer and press **Ctrl+V** in LAN Drop to queue them for sending.

The computers must both be awake with LAN Drop open. If automatic discovery does not find the other computer, enter its address shown in the app, including the port.

## Install and update

Download the Windows setup installer from the [latest release](https://github.com/j355311/lan-drop/releases/latest) and run it. In LAN Drop, select **Check for updates** to check and download a newer version inside the app. When it finishes, choose **Restart now** to install the update and reopen LAN Drop automatically. The first update-enabled release must be installed once with the setup installer; future updates do not require unzipping or manually replacing the app.

## Build from source

Run `npm install`, then `npm start` for development. Run `npm run dist` to create a portable Windows executable in `dist-final`.

The app is for the same local network. File and note transfers are not encrypted in transit; only run it on a network you trust.
