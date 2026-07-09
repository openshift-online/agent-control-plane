# SessionEvent

## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**Id** | Pointer to **string** |  | [optional] 
**Kind** | Pointer to **string** |  | [optional] 
**Href** | Pointer to **string** |  | [optional] 
**CreatedAt** | Pointer to **time.Time** |  | [optional] 
**UpdatedAt** | Pointer to **time.Time** |  | [optional] 
**SessionId** | Pointer to **string** | ID of the parent session | [optional] [readonly] 
**Seq** | Pointer to **int64** | Monotonic sequence within session; gaps allowed after compression | [optional] [readonly] 
**EventType** | Pointer to **string** | AG-UI event type. One of 33 types: RUN_STARTED, RUN_FINISHED, RUN_ERROR, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, TOOL_CALL_RESULT, THINKING_TEXT_MESSAGE_CONTENT, REASONING_MESSAGE_CONTENT, etc. | [optional] 
**Payload** | Pointer to **string** | JSON-encoded event payload; structure varies by event type | [optional] 
**CompletedAt** | Pointer to **NullableTime** | Last event timestamp for compressed events; null for uncompressed | [optional] [readonly] 
**EventCount** | Pointer to **int32** | Number of raw events compressed into this row (1 &#x3D; uncompressed) | [optional] [readonly] [default to 1]

## Methods

### NewSessionEvent

`func NewSessionEvent() *SessionEvent`

NewSessionEvent instantiates a new SessionEvent object
This constructor will assign default values to properties that have it defined,
and makes sure properties required by API are set, but the set of arguments
will change when the set of required properties is changed

### NewSessionEventWithDefaults

`func NewSessionEventWithDefaults() *SessionEvent`

NewSessionEventWithDefaults instantiates a new SessionEvent object
This constructor will only assign default values to properties that have it defined,
but it doesn't guarantee that properties required by API are set

### GetId

`func (o *SessionEvent) GetId() string`

GetId returns the Id field if non-nil, zero value otherwise.

### GetIdOk

`func (o *SessionEvent) GetIdOk() (*string, bool)`

GetIdOk returns a tuple with the Id field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetId

`func (o *SessionEvent) SetId(v string)`

SetId sets Id field to given value.

### HasId

`func (o *SessionEvent) HasId() bool`

HasId returns a boolean if a field has been set.

### GetKind

`func (o *SessionEvent) GetKind() string`

GetKind returns the Kind field if non-nil, zero value otherwise.

### GetKindOk

`func (o *SessionEvent) GetKindOk() (*string, bool)`

GetKindOk returns a tuple with the Kind field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetKind

`func (o *SessionEvent) SetKind(v string)`

SetKind sets Kind field to given value.

### HasKind

`func (o *SessionEvent) HasKind() bool`

HasKind returns a boolean if a field has been set.

### GetHref

`func (o *SessionEvent) GetHref() string`

GetHref returns the Href field if non-nil, zero value otherwise.

### GetHrefOk

`func (o *SessionEvent) GetHrefOk() (*string, bool)`

GetHrefOk returns a tuple with the Href field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetHref

`func (o *SessionEvent) SetHref(v string)`

SetHref sets Href field to given value.

### HasHref

`func (o *SessionEvent) HasHref() bool`

HasHref returns a boolean if a field has been set.

### GetCreatedAt

`func (o *SessionEvent) GetCreatedAt() time.Time`

GetCreatedAt returns the CreatedAt field if non-nil, zero value otherwise.

### GetCreatedAtOk

`func (o *SessionEvent) GetCreatedAtOk() (*time.Time, bool)`

GetCreatedAtOk returns a tuple with the CreatedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCreatedAt

`func (o *SessionEvent) SetCreatedAt(v time.Time)`

SetCreatedAt sets CreatedAt field to given value.

### HasCreatedAt

`func (o *SessionEvent) HasCreatedAt() bool`

HasCreatedAt returns a boolean if a field has been set.

### GetUpdatedAt

`func (o *SessionEvent) GetUpdatedAt() time.Time`

GetUpdatedAt returns the UpdatedAt field if non-nil, zero value otherwise.

### GetUpdatedAtOk

`func (o *SessionEvent) GetUpdatedAtOk() (*time.Time, bool)`

GetUpdatedAtOk returns a tuple with the UpdatedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetUpdatedAt

`func (o *SessionEvent) SetUpdatedAt(v time.Time)`

SetUpdatedAt sets UpdatedAt field to given value.

### HasUpdatedAt

`func (o *SessionEvent) HasUpdatedAt() bool`

HasUpdatedAt returns a boolean if a field has been set.

### GetSessionId

`func (o *SessionEvent) GetSessionId() string`

GetSessionId returns the SessionId field if non-nil, zero value otherwise.

### GetSessionIdOk

`func (o *SessionEvent) GetSessionIdOk() (*string, bool)`

GetSessionIdOk returns a tuple with the SessionId field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSessionId

`func (o *SessionEvent) SetSessionId(v string)`

SetSessionId sets SessionId field to given value.

### HasSessionId

`func (o *SessionEvent) HasSessionId() bool`

HasSessionId returns a boolean if a field has been set.

### GetSeq

`func (o *SessionEvent) GetSeq() int64`

GetSeq returns the Seq field if non-nil, zero value otherwise.

### GetSeqOk

`func (o *SessionEvent) GetSeqOk() (*int64, bool)`

GetSeqOk returns a tuple with the Seq field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetSeq

`func (o *SessionEvent) SetSeq(v int64)`

SetSeq sets Seq field to given value.

### HasSeq

`func (o *SessionEvent) HasSeq() bool`

HasSeq returns a boolean if a field has been set.

### GetEventType

`func (o *SessionEvent) GetEventType() string`

GetEventType returns the EventType field if non-nil, zero value otherwise.

### GetEventTypeOk

`func (o *SessionEvent) GetEventTypeOk() (*string, bool)`

GetEventTypeOk returns a tuple with the EventType field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetEventType

`func (o *SessionEvent) SetEventType(v string)`

SetEventType sets EventType field to given value.

### HasEventType

`func (o *SessionEvent) HasEventType() bool`

HasEventType returns a boolean if a field has been set.

### GetPayload

`func (o *SessionEvent) GetPayload() string`

GetPayload returns the Payload field if non-nil, zero value otherwise.

### GetPayloadOk

`func (o *SessionEvent) GetPayloadOk() (*string, bool)`

GetPayloadOk returns a tuple with the Payload field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetPayload

`func (o *SessionEvent) SetPayload(v string)`

SetPayload sets Payload field to given value.

### HasPayload

`func (o *SessionEvent) HasPayload() bool`

HasPayload returns a boolean if a field has been set.

### GetCompletedAt

`func (o *SessionEvent) GetCompletedAt() time.Time`

GetCompletedAt returns the CompletedAt field if non-nil, zero value otherwise.

### GetCompletedAtOk

`func (o *SessionEvent) GetCompletedAtOk() (*time.Time, bool)`

GetCompletedAtOk returns a tuple with the CompletedAt field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetCompletedAt

`func (o *SessionEvent) SetCompletedAt(v time.Time)`

SetCompletedAt sets CompletedAt field to given value.

### HasCompletedAt

`func (o *SessionEvent) HasCompletedAt() bool`

HasCompletedAt returns a boolean if a field has been set.

### SetCompletedAtNil

`func (o *SessionEvent) SetCompletedAtNil(b bool)`

 SetCompletedAtNil sets the value for CompletedAt to be an explicit nil

### UnsetCompletedAt
`func (o *SessionEvent) UnsetCompletedAt()`

UnsetCompletedAt ensures that no value is present for CompletedAt, not even an explicit nil
### GetEventCount

`func (o *SessionEvent) GetEventCount() int32`

GetEventCount returns the EventCount field if non-nil, zero value otherwise.

### GetEventCountOk

`func (o *SessionEvent) GetEventCountOk() (*int32, bool)`

GetEventCountOk returns a tuple with the EventCount field if it's non-nil, zero value otherwise
and a boolean to check if the value has been set.

### SetEventCount

`func (o *SessionEvent) SetEventCount(v int32)`

SetEventCount sets EventCount field to given value.

### HasEventCount

`func (o *SessionEvent) HasEventCount() bool`

HasEventCount returns a boolean if a field has been set.


[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)


