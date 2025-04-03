#!/bin/bash
#- - - - . - - - - . - - - - . - - - - . - - - - . - - - - .
   readonly TITLE='recon.sh'
#  DESCRIPTION : Survey tool for aruba Access Points
#  WRITER : Satoshi Sakanoshita
   readonly VER='k003'
#- - - - . - - - - . - - - - . - - - - . - - - - . - - - - .

# 端末環境
export LANG="en_US"
export TERM="xterm"
xset s off -dpms
xset s noblank

# ログ取得関数 aruba-555
function get_ap_log()
{
	host_ip=$1
	host_usr=$2
	host_pw=$3

	echo "Connection opened by ${host_ip} (aruba VC)"

	(sleep 1;
	echo -en "${host_usr}\r";
	sleep 1;
	echo -en "${host_pw}\r";
	sleep 1;
	echo -en "${CMD_CLT_AP}\r";
	sleep 3;
	echo -en "${CMD_CLT_TRH}\r";
	sleep 1;
	echo -en "${CMD_CLT_SUM}\r";
	sleep 1;
	echo -en "exit\r";
	) | telnet "$host_ip" >> "$IAP_TMP_LOG"
}

# ログ取得関数 QX switch
function get_qx_log()
{
	host_ip=$1
	host_pw=$2

	echo "Connection opened by ${host_ip} (Switch)"

	(sleep 1;
	echo -en "${host_pw}\r";
	sleep 3;
	echo -en "${CMD_DHCP_INFO_P0}\r";
#	sleep 1;
#	echo -en "${CMD_DHCP_INFO_P1}\r";
	sleep 1;
	echo -en "exit\r";
	) | telnet "$host_ip" >> "$IAP_TMP_LOG"
}


# ===  1. Get log from console  ===
#  telnetでログを取得し、改行コードを修正

# 通信パラメータ 
readonly IAP_IP="172.21.7.220"
readonly IAP_USER="admin"
readonly IAP_PWD="k1kuk@w@"

readonly IAP2_IP="192.168.3.240"
readonly IAP2_USER="admin"
readonly IAP2_PWD="k1kuk@w@"

readonly SW10_IP="172.20.7.253"
readonly SW10_PWD="CX1U53AM"

# コンソール命令 aruba-555
readonly CMD_CLT_AP="show aps"	 	# ap information
readonly CMD_CLT_TRH="show amp-audit"	# max-clients-threshold
readonly CMD_CLT_SUM="show network"	# clients per ssid

# コンソール命令 QX switch
# dhcp information
readonly CMD_DHCP_INFO_P0="display dhcp server stat pool 0"
# readonly CMD_DHCP_INFO_P1="display dhcp server stat pool 1"

# ファイル
readonly IAP_TMP_LOG="./iap_tmp.log"	# log tmp file
readonly TMPL_HTML="./template.html"	# template file
readonly TMP_HTML="./.recon.html.tmp"	# temporary file
readonly RESULT_HTML="./recon.html"	# output

# APマップの桁数
readonly COLUMN=8


# ログ初期化
rm $IAP_TMP_LOG
touch $IAP_TMP_LOG

# ログ取得
get_ap_log $IAP_IP $IAP_USER $IAP_PWD
# get_ap_log $IAP2_IP $IAP2_USER $IAP2_PWD
get_qx_log $SW10_IP $SW10_PWD

# 改行コード変換 CRLF to LF
sed -i 's/\r//g' $IAP_TMP_LOG

# ===  2. Extract values from log, create an array ===
# ログからAP情報を抽出し、ケーブル名に結びつける
# grepで抽出、AP名でsort、awkで配列を宣言し、evalで配列にする

# 抽出︰AP情報
# 格納︰$AP名="AP名 現在の接続数 SSID名 チャンネル 信号強度";
mapfile -t ap_info < <(grep "^work_[0-9][0-9] " $IAP_TMP_LOG | sort | awk '{ printf("%s=\"%s %s %s %s %s\";\n",$1,$1,$5,$9,$11,$12)}')
eval "${ap_info[*]}"

# 抽出︰SSIDごとの現在の接続数 (SSID名 現在接続数)
# mapfile -t ssid_info < <(grep "\s\+\([0-9][0-9]\-WORK\|SHS-A\).\+VLAN.\+Enabled" $IAP_TMP_LOG | awk '{printf("%s %s\n",$2,$3)}')
mapfile -t ssid_info < <(grep "\s\+[0-9][0-9]\-WORK.\+VLAN.\+Enabled" $IAP_TMP_LOG | awk '{printf("%s %s\n",$2,$3)}')

declare -A ssid_maxclt
# 抽出︰SSIDごとの最大接続数 (ssid_maxclt[SSID名]=最大接続数)
mapfile -t ssid_maxclt_txt < <(grep -E "ssid-profile|max-clients-threshold" $IAP_TMP_LOG | awk '{ if ( /ssid-profile/ ){printf("ssid_maxclt[%s]=",$3)} else {print($2)} }')
eval "${ssid_maxclt_txt[*]}"

# 抽出︰DHCPプールごとのアドレス使用率 (pool番号 使用率)
mapfile -t dhcp_info < <(grep -E "display dhcp server stat|Pool utilization" $IAP_TMP_LOG | awk '{ if ( /display dhcp/ ) {printf("%s ",$6)} else {print($3)} }')

# 格納︰配列=("ケーブル名, AP名, 接続数, SSID名"...)
# ケーブル番号とAP機器の対応を定義
declare -a cables
cables=(
"cable_01 $work_01"
"cable_02 $work_02"
"cable_03 $work_03"
"cable_04 $work_04"
"cable_05 $work_05"
"cable_06 $work_06"
"cable_07 $work_07"
"cable_08 $work_08"
"cable_09 $work_09"
"cable_10 $work_10"
"cable_11 $work_11"
"cable_12 $work_12"
"cable_13 $work_13"
"cable_14 $work_14"
"cable_15 $work_15"
"cable_16 $work_16"
)

# ===  3. Assemble HTML file  ===
#  HTML組立

# html組立︰APマップ
apmap='<table id="apmap"><tr>'
for ((i=0;i<${#cables[@]};i++))
do
	# AP情報を読込︰ケーブル名, AP名, 接続数, SSID名, チャンネル, 信号強度
	read  cable_name  ap_name  clients ssid ch dbm < <(echo "${cables[$i]}")
	ssid=$(echo $ssid | sed -E "s/,.+//")
	# 負荷計算︰負荷率、レベル色
	if [[ ${clients} =~ ^[0-9]+$ ]] ; then
		load=$(("$clients" * 100 / ${ssid_maxclt[$ssid]}))
		level=$(("$load" / 10))
		if [ "$level" -gt 10 ]; then
			level=10
		elif [ $level -lt 0 ]; then
			level=0
		fi
	else	# 接続数0は無視
		load=0
		level=0
	fi

    cable_no=$( echo $cable_name | sed -e "s/^cable_//" )

    apmap+=$(cat <<END
<td class="ap lv${level}"><div class="top">cable <span>${cable_no}</span></div>
<div class="mid">${clients}<span>台</span></div>
<div class="bottom">${load}%</div>
<div class="ssid">${ssid}<br>${ch}ch&nbsp;/&nbsp;${dbm}dBm</div></td>
END
)

if  [ $i -eq $(($COLUMN - 1)) ]; then
    apmap+='</tr><tr>'
fi 

done
apmap+='</tr></table>'

# html組立︰SSID情報
col_ssid='<th></th>'	# SSID名
col_clt='<td class="rtitle">総数</td>'	# 現在接続数
col_maxclt='<td class="rtitle">上限/AP</td>'	# 最大接続数

for j in "${ssid_info[@]}"
do
	# SSID情報を読込︰SSID名、接続数 
	read ssid_name clt_cnt < <(echo "$j")

	col_ssid+="<th>$ssid_name</th>"
	col_clt+="<td>$clt_cnt</td>"
	col_maxclt+="<td>${ssid_maxclt[$ssid_name]}</td>"

done

# html組立：最大接続数
ssid_maxclt_table='<table id="ssid_maxclt"><tr>'${col_ssid}'</tr><tr>'${col_maxclt}'</tr></table>'
# html組立：現在接続数
ssid_table='<table id="ssid_cnt"><tr>'${col_ssid}'</tr><tr>'${col_clt}'</tr></table>'

# html組立︰更新時刻
date_sec=$(date -u +%s)
mtime='<input type="hidden" id="mtime" value="'${date_sec}'">'

# 生成︰DHCPレベル色(最大値)
dhcp_lvl=0
for l in "${dhcp_info[@]}"
do
	tmp_lvl=$(echo "$l" | sed -E "s/^.+ |.[0-9]+%//g")
	if [[ ${tmp_lvl} =~ ^[0-9]+$ ]]; then
		tmp_lvl=$(("$tmp_lvl" / 10))
		if [ "$tmp_lvl" -gt $dhcp_lvl ]; then
			dhcp_lvl=$tmp_lvl
		fi
	fi
done

# html組立︰DHCPアドレス使用率
dhcp_use_info=
for k in "${dhcp_info[@]}"
do
	# DHCP情報を読込︰DHCP名、アドレス使用率
	read dhcp_name dhcp_cnt < <(echo "$k")
	dhcp_use_info="$dhcp_use_info""pool_$dhcp_name=$dhcp_cnt "
done

# 生成︰現時刻
ptime=$(date '+%Y/%m/%d(%a) %X')

# html組立︰infoバー生成
infobar=$(cat <<END
<table id="infobar"><tr>
<td id="dhcp" class="lv${dhcp_lvl}">DHCP: ${dhcp_use_info}</td>
<td id="ptime">${ptime}</td>
</tr><tr>
<td id="title">title&nbsp;:&nbsp;${TITLE}</td>
<td id="version">version&nbsp;:&nbsp;${VER}</td>
</tr></table>
END
)

# ファイル出力：一時ファイル
# 更新時刻 + APマップ + DHCP情報 + SSID情報 + バージョン

insert_data=$(cat <<END
$mtime
$apmap
$ssid_maxclt_table
$ssid_table
$infobar
END
)

insert_line=$(sed -n '/MONITORING_DATA/=' $TMPL_HTML)

cat $TMPL_HTML | awk "NR<$insert_line {print}" > $TMP_HTML
echo $insert_data >> $TMP_HTML
cat $TMPL_HTML | awk "NR>$insert_line {print}" >> $TMP_HTML

# 排他制御：一時ファイル > 表示用ファイル
cp "$TMP_HTML" "$RESULT_HTML" 

# コンソール出力
echo 'recon.sh is watching LAN   '"[$(date)]"
echo ' - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - '
