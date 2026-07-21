// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// types and methods for wsh rpc calls
package wshrpc

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/telemetry/telemetrydata"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

type RespOrErrorUnion[T any] struct {
	Response T
	Error    error
}

type MultiArg struct {
	Args []any `json:"args"`
}

// Instructions for adding a new RPC call
// * methods must end with Command
// * methods must take context as their first parameter
// * methods may take additional typed parameters, and may return either just an error, or one return value plus an error
// * after modifying WshRpcInterface, run `task generate` to regnerate bindings

type WshRpcInterface interface {
	CoreCommands
	BlockCommands
	ConnCommands
	ProjectCommands
	AgentCommands
	MemoryCommands
	ChannelCommands
	RunCommands
	RadarCommands
	JarvisCommands
	JobCommands
	SecretCommands
	VDomCommands
	AskCommands
	WshRpcRemoteFileInterface
	WshRpcFileInterface
}

type CoreCommands interface {
	AuthenticateCommand(ctx context.Context, data string) (CommandAuthenticateRtnData, error)
	AuthenticateTokenCommand(ctx context.Context, data CommandAuthenticateTokenData) (CommandAuthenticateRtnData, error)
	AuthenticateTokenVerifyCommand(ctx context.Context, data CommandAuthenticateTokenData) (CommandAuthenticateRtnData, error) // (special) validates token without binding, root router only
	AuthenticateJobManagerCommand(ctx context.Context, data CommandAuthenticateJobManagerData) error
	AuthenticateJobManagerVerifyCommand(ctx context.Context, data CommandAuthenticateJobManagerData) error // (special) validates job auth token without binding, root router only
	RouteAnnounceCommand(ctx context.Context) error                                                        // (special) announces a new route to the main router
	RouteUnannounceCommand(ctx context.Context) error                                                      // (special) unannounces a route to the main router
	ControlGetRouteIdCommand(ctx context.Context) (string, error)                                          // (special) gets the route for the link that we're on
	SetPeerInfoCommand(ctx context.Context, peerInfo string) error
	GetJwtPublicKeyCommand(ctx context.Context) (string, error) // (special) gets the public JWT signing key
	MessageCommand(ctx context.Context, data CommandMessageData) error
	GetMetaCommand(ctx context.Context, data CommandGetMetaData) (waveobj.MetaMapType, error)
	SetMetaCommand(ctx context.Context, data CommandSetMetaData) error
	ResolveIdsCommand(ctx context.Context, data CommandResolveIdsData) (CommandResolveIdsRtnData, error)
	WaitForRouteCommand(ctx context.Context, data CommandWaitForRouteData) (bool, error)
	EventPublishCommand(ctx context.Context, data wps.WaveEvent) error
	EventSubCommand(ctx context.Context, data wps.SubscriptionRequest) error
	EventUnsubCommand(ctx context.Context, data string) error
	EventReadHistoryCommand(ctx context.Context, data CommandEventReadHistoryData) ([]*wps.WaveEvent, error)
	WriteTempFileCommand(ctx context.Context, data CommandWriteTempFileData) (string, error)
	StreamTestCommand(ctx context.Context) chan RespOrErrorUnion[int]
	TestCommand(ctx context.Context, data string) error
	TestMultiArgCommand(ctx context.Context, arg1 string, arg2 int, arg3 bool) (string, error)
	SetConfigCommand(ctx context.Context, data MetaSettingsType) error
	SetConnectionsConfigCommand(ctx context.Context, data ConnConfigRequest) error
	GetFullConfigCommand(ctx context.Context) (wconfig.FullConfigType, error)
	GetWaveAIModeConfigCommand(ctx context.Context) (wconfig.AIModeConfigUpdate, error)
	WaveInfoCommand(ctx context.Context) (*WaveInfoData, error)
	MacOSVersionCommand(ctx context.Context) (string, error)
	WshActivityCommand(ct context.Context, data map[string]int) error
	RecordTEventCommand(ctx context.Context, data telemetrydata.TEvent) error
	GetVarCommand(ctx context.Context, data CommandVarData) (*CommandVarResponseData, error)
	GetAllVarsCommand(ctx context.Context, data CommandVarData) ([]CommandVarResponseData, error)
	SetVarCommand(ctx context.Context, data CommandVarData) error
	PathCommand(ctx context.Context, data PathCommandData) (string, error)
	SendTelemetryCommand(ctx context.Context) error
	FetchSuggestionsCommand(ctx context.Context, data FetchSuggestionsData) (*FetchSuggestionsResponse, error)
	DisposeSuggestionsCommand(ctx context.Context, widgetId string) error
	UpdateWorkspaceTabIdsCommand(ctx context.Context, workspaceId string, tabIds []string) error
	GetAllBadgesCommand(ctx context.Context) ([]baseds.BadgeEvent, error)
	// eventrecv is special, it's handled internally by WshRpc with EventListener
	EventRecvCommand(ctx context.Context, data wps.WaveEvent) error
	BadgeWatchPidCommand(ctx context.Context, data CommandBadgeWatchPidData) error
	// emain
	ElectronEncryptCommand(ctx context.Context, data CommandElectronEncryptData) (*CommandElectronEncryptRtnData, error)
	ElectronDecryptCommand(ctx context.Context, data CommandElectronDecryptData) (*CommandElectronDecryptRtnData, error)
	// ai
	WaveAIAddContextCommand(ctx context.Context, data CommandWaveAIAddContextData) error
	WaveAIGetToolDiffCommand(ctx context.Context, data CommandWaveAIGetToolDiffData) (*CommandWaveAIGetToolDiffRtnData, error)
	// rtinfo
	GetRTInfoCommand(ctx context.Context, data CommandGetRTInfoData) (*waveobj.ObjRTInfo, error)
	SetRTInfoCommand(ctx context.Context, data CommandSetRTInfoData) error
	WaveFileReadStreamCommand(ctx context.Context, data CommandWaveFileReadStreamData) (*WaveFileInfo, error)
	// jobs
	AuthenticateToJobManagerCommand(ctx context.Context, data CommandAuthenticateToJobData) error
}

// for frontend
type WshServerCommandMeta struct {
	CommandType string `json:"commandtype"`
}

type RpcOpts struct {
	Timeout    int64  `json:"timeout,omitempty"`
	NoResponse bool   `json:"noresponse,omitempty"`
	Route      string `json:"route,omitempty"`

	StreamCancelFn func(context.Context) error `json:"-"` // this is an *output* parameter, set by the handler
}

type RpcContext struct {
	SockName  string `json:"sockname,omitempty"`  // the domain socket name
	RouteId   string `json:"routeid"`             // the routeid from the jwt
	ProcRoute bool   `json:"procroute,omitempty"` // use a random procid for route
	BlockId   string `json:"blockid,omitempty"`   // blockid for this rpc
	Conn      string `json:"conn,omitempty"`      // the conn name
	IsRouter  bool   `json:"isrouter,omitempty"`  // if this is for a sub-router
}

func (rc RpcContext) GenerateRouteId() string {
	if rc.RouteId != "" {
		return rc.RouteId
	}
	return "proc:" + uuid.New().String()
}

type CommandAuthenticateRtnData struct {
	RouteId string `json:"routeid"`

	// these fields are only set when doing a token swap
	Env            map[string]string `json:"env,omitempty"`
	InitScriptText string            `json:"initscripttext,omitempty"`
	RpcContext     *RpcContext       `json:"rpccontext,omitempty"`
}

type CommandAuthenticateTokenData struct {
	Token string `json:"token"`
}

type CommandMessageData struct {
	Message string `json:"message"`
}

type CommandGetMetaData struct {
	ORef waveobj.ORef `json:"oref"`
}

type CommandSetMetaData struct {
	ORef waveobj.ORef        `json:"oref"`
	Meta waveobj.MetaMapType `json:"meta"`
}

type CommandResolveIdsData struct {
	BlockId string   `json:"blockid"`
	Ids     []string `json:"ids"`
}

type CommandResolveIdsRtnData struct {
	ResolvedIds map[string]waveobj.ORef `json:"resolvedids"`
}

type CommandWaitForRouteData struct {
	RouteId string `json:"routeid"`
	WaitMs  int    `json:"waitms"`
}

type CommandEventReadHistoryData struct {
	Event    string `json:"event"`
	Scope    string `json:"scope"`
	MaxItems int    `json:"maxitems"`
}

type CpuDataRequest struct {
	Id    string `json:"id"`
	Count int    `json:"count"`
}

type CpuDataType struct {
	Time  int64   `json:"time"`
	Value float64 `json:"value"`
}

type CommandWriteTempFileData struct {
	FileName string `json:"filename"`
	Data64   string `json:"data64"`
}

const (
	TimeSeries_Cpu = "cpu"
)

type TimeSeriesData struct {
	Ts     int64              `json:"ts"`
	Values map[string]float64 `json:"values"`
}

type MetaSettingsType struct {
	waveobj.MetaMapType
}

func (m *MetaSettingsType) UnmarshalJSON(data []byte) error {
	var metaMap waveobj.MetaMapType
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&metaMap); err != nil {
		return err
	}
	*m = MetaSettingsType{MetaMapType: metaMap}
	return nil
}

func (m MetaSettingsType) MarshalJSON() ([]byte, error) {
	return json.Marshal(m.MetaMapType)
}

type ConnConfigRequest struct {
	Host        string              `json:"host"`
	MetaMapType waveobj.MetaMapType `json:"metamaptype"`
}

type BranchInfo struct {
	Name string `json:"name"`
	Age  string `json:"age"`
}

type WebSelectorOpts struct {
	All   bool `json:"all,omitempty"`
	Inner bool `json:"inner,omitempty"`
}

type CommandWebSelectorData struct {
	WorkspaceId string           `json:"workspaceid"`
	BlockId     string           `json:"blockid"`
	TabId       string           `json:"tabid"`
	Selector    string           `json:"selector"`
	Opts        *WebSelectorOpts `json:"opts,omitempty"`
}

type WaveNotificationOptions struct {
	Title  string `json:"title,omitempty"`
	Body   string `json:"body,omitempty"`
	Silent bool   `json:"silent,omitempty"`
}

type WaveInfoData struct {
	Version   string `json:"version"`
	ClientId  string `json:"clientid"`
	BuildTime string `json:"buildtime"`
	ConfigDir string `json:"configdir"`
	DataDir   string `json:"datadir"`
}

type AIAttachedFile struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Size   int    `json:"size"`
	Data64 string `json:"data64"`
}

type CommandWaveAIAddContextData struct {
	Files   []AIAttachedFile `json:"files,omitempty"`
	Text    string           `json:"text,omitempty"`
	Submit  bool             `json:"submit,omitempty"`
	NewChat bool             `json:"newchat,omitempty"`
}

type CommandWaveAIGetToolDiffData struct {
	ChatId     string `json:"chatid"`
	ToolCallId string `json:"toolcallid"`
}

type CommandWaveAIGetToolDiffRtnData struct {
	OriginalContents64 string `json:"originalcontents64"`
	ModifiedContents64 string `json:"modifiedcontents64"`
}

type CommandVarData struct {
	Key      string `json:"key"`
	Val      string `json:"val,omitempty"`
	Remove   bool   `json:"remove,omitempty"`
	ZoneId   string `json:"zoneid"`
	FileName string `json:"filename"`
}

type CommandVarResponseData struct {
	Key    string `json:"key"`
	Val    string `json:"val"`
	Exists bool   `json:"exists"`
}

type SubagentFileInfo struct {
	AgentId        string `json:"agentid"`
	TranscriptPath string `json:"transcriptpath"`
	FirstPrompt    string `json:"firstprompt"`
	StartedAtMs    int64  `json:"startedatms"`
	Done           bool   `json:"done"` // last record is a terminal assistant turn (finished; outcome unknown)
}

type UsageBucket struct {
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	Day           string `json:"day"`
	Input         int    `json:"input"`
	Output        int    `json:"output"`
	CacheRead     int    `json:"cacheread"`
	CacheCreate   int    `json:"cachecreate"`
	CacheCreate1h int    `json:"cachecreate1h"`
	Msgs          int    `json:"msgs"`
}

type SessionInfo struct {
	ID            string `json:"id"`
	Runtime       string `json:"runtime"`
	ProjectPath   string `json:"projectpath"`
	ProjectName   string `json:"projectname"`
	Branch        string `json:"branch"`
	Task          string `json:"task"`
	Model         string `json:"model"`
	TokensTotal   int    `json:"tokenstotal"`
	LastActiveTs  int64  `json:"lastactivets"`
	ResumeCommand string `json:"resumecommand"`
}

type ConsultRuntimeInfo struct {
	Runtime   string `json:"runtime"`
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
}

type SessionEvent struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
	Text string `json:"text"`
}

type SessionActivity struct {
	ID             string         `json:"id"`
	Runtime        string         `json:"runtime"`
	ProjectPath    string         `json:"projectpath"`
	ProjectName    string         `json:"projectname"`
	Branch         string         `json:"branch"`
	Task           string         `json:"task"`
	Model          string         `json:"model"`
	TokensTotal    int            `json:"tokenstotal"`
	LastActiveTs   int64          `json:"lastactivets"`
	ResumeCommand  string         `json:"resumecommand"`
	TranscriptPath string         `json:"transcriptpath"`
	Status         string         `json:"status"`
	StartedTs      int64          `json:"startedts"`
	DurationMs     int64          `json:"durationms"`
	Events         []SessionEvent `json:"events"`
}

type MemoryNote struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Type        string   `json:"type"`
	Scope       string   `json:"scope"`
	Source      string   `json:"source"`
	Path        string   `json:"path"`
	Links       []string `json:"links"`
	UpdatedTs   int64    `json:"updatedts"`

	Reviewed       bool   `json:"reviewed"`
	CapturedAt     string `json:"capturedat"`
	SupersededBy   string `json:"supersededby"`
	LastReferenced string `json:"lastreferenced"`
}

type MemoryEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type MemoryLearnCandidate struct {
	Type         string `json:"type"`
	Scope        string `json:"scope,omitempty"`
	Body         string `json:"body"`
	IsCorrection bool   `json:"iscorrection,omitempty"`
	Supersedes   string `json:"supersedes,omitempty"`
}

type MemoryPendingNote struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	Scope      string `json:"scope"`
	Source     string `json:"source"`
	Body       string `json:"body"`
	Cwd        string `json:"cwd"`
	CapturedAt string `json:"capturedat"`
}

type MemoryPruneCandidate struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
	Path   string `json:"path"`
}

type MemoryArchivedNote struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	Reason     string `json:"reason"`     // decay | drift
	ArchivedAt string `json:"archivedat"` // RFC3339
	Path       string `json:"path"`       // path inside the archive dir (Restore target)
	OriginHub  string `json:"originhub"`
}

type PathCommandData struct {
	PathType     string `json:"pathtype"`
	Open         bool   `json:"open"`
	OpenExternal bool   `json:"openexternal"`
	TabId        string `json:"tabid"`
}

type ActivityDisplayType struct {
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	DPR      float64 `json:"dpr"`
	Internal bool    `json:"internal,omitempty"`
}

type ActivityUpdate struct {
	FgMinutes           int                   `json:"fgminutes,omitempty"`
	ActiveMinutes       int                   `json:"activeminutes,omitempty"`
	OpenMinutes         int                   `json:"openminutes,omitempty"`
	WaveAIFgMinutes     int                   `json:"waveaifgminutes,omitempty"`
	WaveAIActiveMinutes int                   `json:"waveaiactiveminutes,omitempty"`
	NumTabs             int                   `json:"numtabs,omitempty"`
	NewTab              int                   `json:"newtab,omitempty"`
	NumBlocks           int                   `json:"numblocks,omitempty"`
	NumWindows          int                   `json:"numwindows,omitempty"`
	NumWS               int                   `json:"numws,omitempty"`
	NumWSNamed          int                   `json:"numwsnamed,omitempty"`
	NumSSHConn          int                   `json:"numsshconn,omitempty"`
	NumWSLConn          int                   `json:"numwslconn,omitempty"`
	NumMagnify          int                   `json:"nummagnify,omitempty"`
	TermCommandsRun     int                   `json:"termcommandsrun,omitempty"`
	NumPanics           int                   `json:"numpanics,omitempty"`
	NumAIReqs           int                   `json:"numaireqs,omitempty"`
	Startup             int                   `json:"startup,omitempty"`
	Shutdown            int                   `json:"shutdown,omitempty"`
	SetTabTheme         int                   `json:"settabtheme,omitempty"`
	BuildTime           string                `json:"buildtime,omitempty"`
	Displays            []ActivityDisplayType `json:"displays,omitempty"`
	Renderers           map[string]int        `json:"renderers,omitempty"`
	Blocks              map[string]int        `json:"blocks,omitempty"`
	WshCmds             map[string]int        `json:"wshcmds,omitempty"`
	Conn                map[string]int        `json:"conn,omitempty"`
}

type FetchSuggestionsData struct {
	SuggestionType string `json:"suggestiontype"`
	Query          string `json:"query"`
	WidgetId       string `json:"widgetid"`
	ReqNum         int    `json:"reqnum"`
	FileCwd        string `json:"file:cwd,omitempty"`
	FileDirOnly    bool   `json:"file:dironly,omitempty"`
	FileConnection string `json:"file:connection,omitempty"`
}

type FetchSuggestionsResponse struct {
	ReqNum      int              `json:"reqnum"`
	Suggestions []SuggestionType `json:"suggestions"`
}

type SuggestionType struct {
	Type         string `json:"type"`
	SuggestionId string `json:"suggestionid"`
	Display      string `json:"display"`
	SubText      string `json:"subtext,omitempty"`
	Icon         string `json:"icon,omitempty"`
	IconColor    string `json:"iconcolor,omitempty"`
	IconSrc      string `json:"iconsrc,omitempty"`
	MatchPos     []int  `json:"matchpos,omitempty"`
	SubMatchPos  []int  `json:"submatchpos,omitempty"`
	Score        int    `json:"score,omitempty"`
	FileMimeType string `json:"file:mimetype,omitempty"`
	FilePath     string `json:"file:path,omitempty"`
	FileName     string `json:"file:name,omitempty"`
	UrlUrl       string `json:"url:url,omitempty"`
}

type CommandGetRTInfoData struct {
	ORef waveobj.ORef `json:"oref"`
}

type CommandSetRTInfoData struct {
	ORef   waveobj.ORef   `json:"oref"`
	Data   map[string]any `json:"data" tstype:"ObjRTInfo"`
	Delete bool           `json:"delete,omitempty"`
}

type CommandTermUpdateAttachedJobData struct {
	BlockId string `json:"blockid"`
	JobId   string `json:"jobid,omitempty"`
}

type CommandElectronEncryptData struct {
	PlainText string `json:"plaintext"`
}

type CommandElectronEncryptRtnData struct {
	CipherText     string `json:"ciphertext"`
	StorageBackend string `json:"storagebackend"` // only returned for linux
}

type CommandElectronDecryptData struct {
	CipherText string `json:"ciphertext"`
}

type CommandElectronDecryptRtnData struct {
	PlainText      string `json:"plaintext"`
	StorageBackend string `json:"storagebackend"` // only returned for linux
}

type StreamMeta struct {
	Id            string `json:"id"`   // streamid
	RWnd          int64  `json:"rwnd"` // initial receive window size
	ReaderRouteId string `json:"readerrouteid"`
	WriterRouteId string `json:"writerrouteid"`
}

type CommandAuthenticateToJobData struct {
	JobAccessToken string `json:"jobaccesstoken"`
}

type CommandAuthenticateJobManagerData struct {
	JobId        string `json:"jobid"`
	JobAuthToken string `json:"jobauthtoken"`
}

type CommandWaveFileReadStreamData struct {
	ZoneId     string     `json:"zoneid"`
	Name       string     `json:"name"`
	StreamMeta StreamMeta `json:"streammeta"`
}

// see blockstore.go (WaveFile)
type WaveFileInfo struct {
	ZoneId    string   `json:"zoneid"`
	Name      string   `json:"name"`
	Opts      FileOpts `json:"opts"`
	CreatedTs int64    `json:"createdts"`
	Size      int64    `json:"size"`
	ModTs     int64    `json:"modts"`
	Meta      FileMeta `json:"meta"`
}

type CommandBadgeWatchPidData struct {
	Pid     int          `json:"pid"`
	ORef    waveobj.ORef `json:"oref"`
	BadgeId string       `json:"badgeid"`
}

// ProcessInfo holds per-process information for the process viewer.
// Mem, MemPct, Cpu, and NumThreads are set to -1 when the data is unavailable
// (e.g. permission denied reading another user's process on macOS).
type ProcessInfo struct {
	Pid        int32   `json:"pid"`
	Ppid       int32   `json:"ppid,omitempty"`
	Command    string  `json:"command,omitempty"`
	Status     string  `json:"status,omitempty"`
	User       string  `json:"user,omitempty"`
	Mem        int64   `json:"mem"`        // resident set size in bytes; -1 if unavailable
	MemPct     float64 `json:"mempct"`     // memory percent; -1 if unavailable
	Cpu        float64 `json:"cpu"`        // cpu percent; -1 if unavailable
	NumThreads int32   `json:"numthreads"` // -1 if unavailable
	Gone       bool    `json:"gone,omitempty"`
}

type ProcessSummary struct {
	Total    int     `json:"total"`
	Load1    float64 `json:"load1,omitempty"`
	Load5    float64 `json:"load5,omitempty"`
	Load15   float64 `json:"load15,omitempty"`
	MemTotal uint64  `json:"memtotal,omitempty"`
	MemUsed  uint64  `json:"memused,omitempty"`
	MemFree  uint64  `json:"memfree,omitempty"`
	NumCPU   int     `json:"numcpu,omitempty"`
	CpuSum   float64 `json:"cpusum,omitempty"`
}

type ProcessListResponse struct {
	Processes     []ProcessInfo  `json:"processes"`
	Summary       ProcessSummary `json:"summary"`
	Ts            int64          `json:"ts"`
	HasCPU        bool           `json:"hascpu,omitempty"`
	Platform      string         `json:"platform,omitempty"`
	TotalCount    int            `json:"totalcount,omitempty"`
	FilteredCount int            `json:"filteredcount,omitempty"`
}

type CommandRemoteProcessListData struct {
	WidgetId   string `json:"widgetid,omitempty"`
	SortBy     string `json:"sortby,omitempty"`
	SortDesc   bool   `json:"sortdesc,omitempty"`
	Start      int    `json:"start,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	TextSearch string `json:"textsearch,omitempty"`
	// LastPidOrder, when set, ignores SortBy/SortDesc/TextSearch and returns processes in the order
	// they were returned in the previous request for this WidgetId (with Gone=true for dead pids).
	LastPidOrder bool `json:"lastpidorder,omitempty"`
	// KeepAlive, when set, overrides all other fields and simply keeps the backend cache alive (returns nil).
	KeepAlive bool `json:"keepalive,omitempty"`
}

type CommandRemoteProcessSignalData struct {
	Pid    int32  `json:"pid"`
	Signal string `json:"signal"`
}
