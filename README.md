# LAN Drop

LAN Drop sends files and notes directly between Windows computers on the same local network. It does not upload them to a cloud service. The receiving computer shows an approval prompt before saving each file or note.

## Use on two computers

1. Open LAN Drop on both computers and connect them to the same local network.
2. If Windows Firewall asks, allow LAN Drop on **Private networks**.
3. If Windscribe is running, turn on **Preferences → Connection → Allow LAN Traffic**.
4. Drag files into the app, choose files, or paste a copied file or image with **Ctrl+V**. Select the other computer and choose **Send files**. LAN Drop sends regular files of any type directly; ZIP files are optional.
5. Accept the incoming file on the receiving computer. Files save to `Downloads\LAN Drop` by default. Open **Settings** to add saved folders and choose one active save location; right-click a saved location to remove it from the list without deleting its folder or files.
6. Right-click a completed incoming transfer to open the downloaded file or show it in its folder.
7. To send a note, select a computer, write in **Send a note**, and choose **Send note**. The recipient must accept it. Sent and accepted notes are saved in each computer's local LAN Drop history.
8. Use **Copy** and **Paste** in the note area, or use the standard Windows shortcuts. The file queue also accepts copied images and files from File Explorer with **Ctrl+V**.

The computers must both be awake with LAN Drop open. If automatic discovery does not find the other computer, enter its address shown in the app, including the port.

## Install and update

Download the Windows setup installer from the [latest release](https://github.com/j355311/lan-drop/releases/latest) and run it. In LAN Drop, select **Check for updates** to check and download a newer version inside the app. When it finishes, choose **Restart now** to install the update and reopen LAN Drop automatically. The first update-enabled release must be installed once with the setup installer; future updates do not require unzipping or manually replacing the app.

## Build from source

Run `npm install`, then `npm start` for development. Run `npm run dist` to create the Windows setup installer in `dist-final`.

The app is for the same local network. File and note transfers are not encrypted in transit; only run it on a network you trust.
