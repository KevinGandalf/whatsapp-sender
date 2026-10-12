# Vorlauf

WhatsApp-Nachrichten aus dem Kalender und aus wiederkehrenden Terminen. Mehrere Konten teilen sich eine Empfängerliste. Admins verbinden WhatsApp und vergeben Rollen, Nutzer planen ihre eigenen Sendungen.

Diese Anleitung richtet Vorlauf auf einem internen Server ein. Die Vorschau in Grok bleibt davon unberührt.

## Was der Server können muss

- Node.js 22 und npm
- PostgreSQL 16, nur vom App-Server aus erreichbar
- Ausgehend HTTPS nach `web.whatsapp.com` (verknüpftes Gerät, wie WhatsApp Web) und, falls genutzt, nach `graph.facebook.com`
- Ein HTTPS-Name im internen Netz, zum Beispiel `https://vorlauf.intern.example`

Die Anmeldung setzt ein Secure-Cookie. Deshalb muss der Browser die Seite über HTTPS öffnen. `http://localhost` ist die einzige Ausnahme. Google- und X-Anmeldung laufen über einen externen Dienst und gehören nicht auf einen abgeschotteten Server. Intern wird mit E-Mail und Passwort gearbeitet.

Nachrichten gehen auch dann raus, wenn niemand die Seite offen hat. Dafür ruft der Server jede Minute `POST /api/pulse` auf. Ohne dieses Geheimnis passiert der Versand nur, solange ein angemeldetes Fenster offen ist.

## 1. Datenbank

```bash
sudo -u postgres createuser --pwprompt vorlauf
sudo -u postgres createdb --owner=vorlauf vorlauf
```

Die Tabellen legt der erste Build selbst an. Es gibt kein separates Migrationskommando, das man vergessen müsste: `npm run build` führt es aus, sobald `DATABASE_URL` gesetzt ist.

## 2. Code holen und bauen

```bash
git clone https://github.com/KevinGandalf/whatsapp-sender.git
cd whatsapp-sender
npm ci
```

Die Variablen gehören in die Dienstumgebung, nicht ins Repository. `BETTER_AUTH_URL` muss exakt die Adresse sein, die im Browser steht, inklusive `https://` und ohne Schrägstrich am Ende.

```bash
export DATABASE_URL="postgresql://vorlauf:GEHEIM@127.0.0.1:5432/vorlauf"
export BETTER_AUTH_URL="https://vorlauf.intern.example"
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export VORLAUF_PULSE_SECRET="$(openssl rand -base64 32)"
# Nur setzen, wenn Exchange im eigenen Netz liegt:
# export VORLAUF_ALLOW_PRIVATE_EWS=true
# Interne Zertifizierungsstelle, falls Exchange ihr vertraut:
# export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/interne-ca.pem

npm run build
```

`BETTER_AUTH_SECRET` danach nicht mehr wechseln, sonst sind alle Sitzungen ungültig.

## 3. Dienst starten

Der Prozess hört standardmäßig nur auf `127.0.0.1:3000`. Davor steht ein Reverse-Proxy mit TLS.

```bash
npm start
```

`HOST` und `PORT` ändern die Bindung, falls der Proxy auf einem anderen Rechner liegt. Dann die Datenbank und den Port nicht ins ganze Netz stellen.

Beispiel für systemd, Datei `/etc/systemd/system/vorlauf.service`:

```ini
[Unit]
Description=Vorlauf
After=network.target postgresql.service

[Service]
Type=simple
User=vorlauf
WorkingDirectory=/opt/whatsapp-sender
Environment=NODE_ENV=production
Environment=DATABASE_URL=postgresql://vorlauf:GEHEIM@127.0.0.1:5432/vorlauf
Environment=BETTER_AUTH_URL=https://vorlauf.intern.example
Environment=BETTER_AUTH_SECRET=langes-zufaelliges-geheimnis
Environment=VORLAUF_PULSE_SECRET=anderes-zufaelliges-geheimnis
Environment=VORLAUF_ALLOW_PRIVATE_EWS=true
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vorlauf
```

Caddy auf demselben Rechner:

```caddy
vorlauf.intern.example {
  reverse_proxy 127.0.0.1:3000
}
```

Der Proxy muss `Host` und `X-Forwarded-Proto` durchreichen. Caddy tut das von selbst. Die Seite danach nur unter `BETTER_AUTH_URL` öffnen, nicht über die nackte IP.

## 4. Versand ohne offenes Fenster

Cron, jede Minute, auf dem App-Server:

```bash
* * * * * curl --silent --show-error --fail --max-time 30 -X POST -H "Authorization: Bearer $VORLAUF_PULSE_SECRET" https://vorlauf.intern.example/api/pulse
```

Die Antwort nennt, wie viele Nachrichten gesendet wurden und wie viele noch warten. Ohne passendes Geheimnis antwortet der Pfad mit 401, und wenn `VORLAUF_PULSE_SECRET` gar nicht gesetzt ist, mit 404.

Pro Aufruf gehen höchstens drei fällige Nachrichten raus. Eine Minute Abstand reicht für den normalen Betrieb.

## 5. Erstes Konto und WhatsApp

1. `https://vorlauf.intern.example` öffnen und das erste Konto anlegen. Dieses Konto ist Admin.
2. Unter **Anbindung** auf **Code anzeigen** gehen. Am Telefon: WhatsApp, verknüpfte Geräte, Gerät hinzufügen, Code scannen. Das ist dieselbe Art Sitzung wie WhatsApp Web. Sie bleibt auf dem Server, solange der Dienst läuft, und nach einem Neustart ohne neuen Code weiter, weil die Anmeldung unter `data/wa-auth` liegt. Diesen Ordner sichern und nicht ins Git legen.
3. Unter **Chats** stehen danach die Unterhaltungen und die letzten Nachrichten. Neue Nachrichten kommen von selbst nach. Antworten aus dem Chat gehen über diese Sitzung.
4. Geplante Regeltermine benutzen dieselbe Sitzung. Die Cloud API darunter ist nur der Ersatz, falls kein Gerät verknüpft ist.
5. Unter **Konten** Rollen und Telefonnummern setzen. Unter **Empfänger** Kontakte anlegen, die kein Konto brauchen.

Cloud API, falls doch benötigt: Phone Number ID und ein dauerhaftes Token mit `whatsapp_business_messaging` aus der Meta-App. Das Token bleibt in der Datenbank. Die Oberfläche zeigt später nur die letzten vier Zeichen.

WhatsApp muss vom Server aus `web.whatsapp.com` erreichen. Medien werden nicht heruntergeladen, im Verlauf steht dann nur die Art, zum Beispiel „Bild“. WhatsApp kann so eine Sitzung trennen. Sie ist für den eigenen Ablauf gedacht, nicht für Massenversand.


## 6. Kalender

| Quelle | Wann |
|---|---|
| Beispiel | Nur zum Ausprobieren, ohne Zugang |
| Microsoft 365 | Graph-Token mit `Calendars.Read`, braucht ausgehend `graph.microsoft.com` |
| Exchange EWS | Adresse `https://mail.firma.example/EWS/Exchange.asmx`, Benutzer und Kennwort oder Bearer-Token |
| Outlook über Grok | Nur in der Grok-Vorschau, nicht auf dem internen Server |

Private Adressen, `.local` und `.internal` sind abgelehnt, bis `VORLAUF_ALLOW_PRIVATE_EWS=true` gesetzt ist. Cloud-Metadaten-Adressen bleiben auch dann gesperrt. EWS muss HTTPS sprechen. Kennwort nicht in die URL schreiben.

Regeltermine hängen nicht am Kalender. Sie laufen täglich, an gewählten Wochentagen oder monatlich am Tag 1–28.

Kalenderregeln erzeugen Nachrichten, wenn jemand die geladenen Termine bewusst anwendet. Sie wiederholen sich nicht von selbst.

## 7. Aktualisieren

```bash
cd /opt/whatsapp-sender
git pull
npm ci
npm run build
sudo systemctl restart vorlauf
```

`DATABASE_URL` muss beim Build gesetzt sein, damit neue Tabellen ankommen. Angewendete Migrationsdateien nicht nachträglich ändern.

## 8. Wenn die Anmeldung scheitert

- „Invalid origin“: die geöffnete Adresse ist nicht `BETTER_AUTH_URL`. Dazu zählen `http` statt `https`, ein anderer Port und ein abschliessender Schrägstrich.
- Die Seite lädt, aber das Konto bleibt weg: der Dienst wurde ohne dasselbe `BETTER_AUTH_SECRET` neu gestartet, oder der Browser hat die Seite nicht über HTTPS geöffnet.
- Es gibt keinen Admin: nur das allererste Konto in einer leeren Datenbank wird Admin. Ein zweites Konto kann ein bestehender Admin unter **Konten** hochstufen.

## Was nicht ins Repository gehört

Zugangstoken, Datenbankpasswort und die beiden Geheimnisse bleiben in der Dienstumgebung. Eine `.env` im Projektordner wird nicht mit ausgeliefert und sollte dort auch nicht liegen bleiben.
