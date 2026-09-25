module github.com/wavetermdev/waveterm

go 1.25.6

require (
	github.com/alexflint/go-filemutex v1.3.0
	github.com/creack/pty v1.1.24
	github.com/emirpasic/gods v1.18.1
	github.com/fsnotify/fsnotify v1.9.0
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/golang-migrate/migrate/v4 v4.19.1
	github.com/google/uuid v1.6.0
	github.com/gorilla/mux v1.8.1
	github.com/gorilla/websocket v1.5.3
	github.com/invopop/jsonschema v0.13.0
	github.com/jmoiron/sqlx v1.4.0
	github.com/joho/godotenv v1.5.1
	github.com/launchdarkly/eventsource v1.11.0
	github.com/mattn/go-sqlite3 v1.14.40
	github.com/mitchellh/mapstructure v1.5.0
	github.com/sawka/txwrap v0.2.0
	github.com/shirou/gopsutil/v4 v4.26.3
	github.com/skratchdot/open-golang v0.0.0-20200116055534-eef842397966
	github.com/spf13/cobra v1.10.2
	golang.org/x/sys v0.43.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/bahlo/generic-list-go v0.2.0 // indirect
	github.com/buger/jsonparser v1.1.2 // indirect
	github.com/ebitengine/purego v0.10.0 // indirect
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/kr/pretty v0.3.1 // indirect
	github.com/lufia/plan9stats v0.0.0-20211012122336-39d0f177ccd0 // indirect
	github.com/mailru/easyjson v0.7.7 // indirect
	github.com/power-devops/perfstat v0.0.0-20240221224432-82ca36839d55 // indirect
	github.com/rogpeppe/go-internal v1.14.1 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	github.com/tklauser/go-sysconf v0.3.16 // indirect
	github.com/tklauser/numcpus v0.11.0 // indirect
	github.com/wk8/go-ordered-map/v2 v2.1.8 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	gopkg.in/check.v1 v1.0.0-20201130134442-10cb98267c6c // indirect
)

replace github.com/kevinburke/ssh_config => github.com/wavetermdev/ssh_config v0.0.0-20241219203747-6409e4292f34

replace github.com/creack/pty => github.com/photostorm/pty v1.1.19-0.20230903182454-31354506054b
